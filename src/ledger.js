import { decodeLog, TOPIC, ZERO_ADDRESS } from "./decode.js";

const RAY = 10n ** 27n;

/**
 * Aave's rayDiv, applied to the magnitude and re-signed, which is what the
 * protocol itself does: it scales a positive amount and then adds or subtracts.
 */
function rayDivSigned(amount, index) {
  if (index === 0n) return 0n;
  const magnitude = amount < 0n ? -amount : amount;
  const scaled = (magnitude * RAY + index / 2n) / index;
  return amount < 0n ? -scaled : scaled;
}

/**
 * Aave v3 aToken event accrual.
 *
 * Every balance change on an interest-bearing Aave token emits one of three
 * events, so the cash-flow identity is exact rather than approximate:
 *
 *   accruedInterest = currentBalance - netPrincipal
 *   netPrincipal    = SUM(Mint:  value - balanceIncrease)
 *                   - SUM(Burn:  value + balanceIncrease)
 *                   + SUM(TransferIn) - SUM(TransferOut)
 *
 * `balanceIncrease` is the interest credited to the balance at that event, which
 * is what separates realised interest from interest still pending.
 *
 * Trap: a withdrawal smaller than the accrued interest emits a *Mint*, with
 * value = balanceIncrease - amountWithdrawn. So a Mint's principal flow can be
 * negative and "Mint means deposit" is wrong.
 *
 * Identity and event semantics verified against 0xcazador/defi-simulator
 * (MIT, utils/tokenEventAccrual.ts).
 */

export { TOPIC };

/** Signed principal delta in base units contributed by one event. */
export function principalFlow(event) {
  const value = event.value;
  const inc = event.balanceIncrease ?? 0n;
  switch (event.kind) {
    case "Mint":
      return value - inc; // may be negative: a burn-side Mint removes principal
    case "Burn":
      return -(value + inc);
    case "TransferIn":
      return value;
    case "TransferOut":
      return -value;
    default:
      throw new Error(`Unknown event kind ${event.kind}`);
  }
}

/**
 * Turn raw logs for one aToken into a chronological, classified ledger.
 *
 * Zero-address Transfers are the ERC-20 mirror of Mint/Burn and are already
 * counted, so only user-to-user transfers count as principal flows here.
 */
export function buildLedger(logs, user) {
  const me = user.toLowerCase();
  const events = [];

  // Aave emits BalanceTransfer alongside the ERC-20 Transfer on an aToken
  // transfer. The Transfer carries underlying units (what principal accounting
  // needs); BalanceTransfer carries the SCALED amount (what the completeness
  // check needs, since a plain Transfer log has no index on it).
  const scaledTransferByTx = new Map();
  for (const log of logs) {
    const parsed = decodeLog(log);
    if (!parsed || parsed.name !== "BalanceTransfer") continue;
    const signed =
      parsed.args.to === me
        ? parsed.args.scaledValue
        : parsed.args.from === me
          ? -parsed.args.scaledValue
          : 0n;
    if (signed !== 0n) {
      scaledTransferByTx.set(log.transactionHash, (scaledTransferByTx.get(log.transactionHash) ?? 0n) + signed);
    }
  }

  for (const log of logs) {
    const parsed = decodeLog(log);
    if (!parsed) continue; // not one of our three events
    const base = {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash,
      timestamp: log.timestamp ?? null,
    };

    if (parsed.name === "Mint" && parsed.args.onBehalfOf === me) {
      events.push({
        ...base,
        kind: "Mint",
        value: parsed.args.value,
        balanceIncrease: parsed.args.balanceIncrease,
        index: parsed.args.index,
      });
    } else if (parsed.name === "Burn" && parsed.args.from === me) {
      events.push({
        ...base,
        kind: "Burn",
        value: parsed.args.value,
        balanceIncrease: parsed.args.balanceIncrease,
        index: parsed.args.index,
      });
    } else if (parsed.name === "Transfer") {
      const { from, to } = parsed.args;
      if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) continue; // mirrors Mint/Burn
      if (to === me) events.push({ ...base, kind: "TransferIn", value: parsed.args.value });
      else if (from === me) events.push({ ...base, kind: "TransferOut", value: parsed.args.value });
    }
  }

  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const transferScaledUsed = new Set();
  return events.map((event) => {
    const delta = principalFlow(event);
    let scaledDelta = 0n;
    if (event.index) {
      scaledDelta = rayDivSigned(delta, event.index);
    } else if (!transferScaledUsed.has(event.txHash)) {
      // One BalanceTransfer covers the transfer leg of its transaction.
      scaledDelta = scaledTransferByTx.get(event.txHash) ?? 0n;
      if (scaledDelta !== 0n) transferScaledUsed.add(event.txHash);
    }
    return {
      ...event,
      principalDelta: delta,
      scaledDelta,
      interestRealized: event.balanceIncrease ?? 0n,
      action: classify(event, delta),
    };
  });
}

function classify(event, delta) {
  if (event.kind === "TransferIn") return "TransferIn";
  if (event.kind === "TransferOut") return "TransferOut";
  if (delta > 0n) return "Supply";
  if (delta < 0n) return "Withdraw";
  return "InterestApplied";
}

/**
 * The position's scaled balance, rebuilt from principal movements alone.
 *
 * This is the completeness check. Aave stores a *scaled* balance that changes
 * only when principal moves: accrued interest never touches it. So comparing
 * this against the contract's own scaledBalanceOf proves whether the event set
 * is complete, which the balance identity alone cannot do, since that identity
 * is built from the same events it would be checking.
 */
export const reconstructedScaled = (ledger) =>
  ledger.reduce((sum, entry) => sum + (entry.scaledDelta ?? 0n), 0n);

/** netPrincipal, in base units. */
export const netPrincipal = (ledger) =>
  ledger.reduce((sum, entry) => sum + entry.principalDelta, 0n);

/** Interest credited at past events (realised), in base units. */
export const realizedInterest = (ledger) =>
  ledger.reduce((sum, entry) => sum + entry.interestRealized, 0n);

/**
 * Lifetime interest, in base units.
 *
 * Aave's ray math can round each balance update by up to a wei, so a genuinely
 * zero-yield position can compute a few wei negative. A negative total within
 * eventCount + 1 wei of zero is dust; anything beyond that is a real data
 * problem and is returned as-is so it surfaces rather than being hidden.
 */
export function accruedInterest(balanceRaw, ledger) {
  const accrued = balanceRaw - netPrincipal(ledger);
  if (accrued < 0n && -accrued <= BigInt(ledger.length + 1)) return 0n;
  return accrued;
}
