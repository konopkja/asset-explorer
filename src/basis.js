/**
 * What did you pay for the tokens you are holding?
 *
 * The answer is already in the wallet's own transfer history and needs no DEX
 * knowledge at all. A swap, whoever routed it, is one transaction in which your
 * balance of one token falls and your balance of another rises. So the trade is
 * read from your net position change per transaction: whatever left the wallet is
 * what you paid, whatever arrived is what you bought. That works identically for
 * Uniswap, CoW, an aggregator, an OTC transfer or a contract nobody has decoded,
 * because none of them can move your tokens without a transfer.
 *
 * Every function here is pure and integer-based on the quantity side. Pricing is
 * injected by the caller, because it is I/O and because a lot whose price cannot
 * be found must stay visibly unpriced rather than quietly becoming zero.
 *
 * What this deliberately cannot see:
 *
 *   - An acquisition with nothing on the other side: an airdrop, a claim, an
 *     exchange withdrawal, or a transfer from your own second wallet. There is no
 *     onchain price for any of those, so they are counted as quantity with an
 *     UNKNOWN basis and are never averaged in as if they were free.
 *   - Native ETH legs, which are not ERC-20 transfers. The caller can supply them
 *     per transaction via `nativeDeltas`; without that, an ETH-funded buy looks
 *     like an acquisition with no counter-leg and is reported as unpriced.
 *   - Gas, so a break-even price is slightly optimistic.
 */

/**
 * Group a wallet's transfers into one net position change per transaction.
 *
 * Netting is what makes this robust: a router that passes a token through the
 * wallet twice, or a transfer to yourself, nets to zero and disappears, so only
 * the real change of ownership survives.
 */
export function transactionDeltas(transfers, user) {
  const owner = user.toLowerCase();
  const byTx = new Map();

  for (const t of transfers) {
    if (!t.txHash) continue;
    const inbound = t.to === owner;
    const outbound = t.from === owner;
    if (inbound === outbound) continue; // neither side, or a self-transfer

    let tx = byTx.get(t.txHash);
    if (!tx) {
      tx = { txHash: t.txHash, timestamp: t.timestamp ?? null, blockNumber: t.blockNumber, deltas: new Map() };
      byTx.set(t.txHash, tx);
    }
    // The sweep can carry several rows for one transaction; the earliest stamp
    // is the transaction's own.
    if (t.timestamp != null && (tx.timestamp == null || t.timestamp < tx.timestamp)) {
      tx.timestamp = t.timestamp;
    }

    const existing = tx.deltas.get(t.token) ?? {
      token: t.token,
      symbol: t.symbol,
      decimals: t.decimals,
      raw: 0n,
    };
    existing.raw += inbound ? t.raw : -t.raw;
    tx.deltas.set(t.token, existing);
  }

  return byTx;
}

const units = (raw, decimals) => Number(raw) / 10 ** decimals;

/**
 * Split one token's history into acquisitions and disposals, each carrying the
 * other side of its transaction.
 *
 * `nativeDeltas` is an optional Map of txHash -> native amount in wei, signed the
 * same way: negative when the wallet spent ETH. It is what turns an ETH-funded
 * buy from "no counter-leg" into a priced lot.
 */
export function lotsForToken(byTx, token, { nativeDeltas = new Map(), nativeSymbol = "ETH" } = {}) {
  const acquisitions = [];
  const disposals = [];

  for (const tx of byTx.values()) {
    const moved = tx.deltas.get(token);
    const nativeRaw = nativeDeltas.get(tx.txHash) ?? 0n;
    if (!moved || moved.raw === 0n) continue;

    const others = [...tx.deltas.values()].filter((d) => d.token !== token && d.raw !== 0n);
    if (nativeRaw !== 0n) {
      others.push({ token: null, symbol: nativeSymbol, decimals: 18, raw: nativeRaw, isNative: true });
    }
    const side = (sign) =>
      others
        .filter((d) => (sign > 0 ? d.raw > 0n : d.raw < 0n))
        .map((d) => ({
          token: d.token,
          symbol: d.symbol,
          decimals: d.decimals,
          isNative: !!d.isNative,
          qty: units(d.raw < 0n ? -d.raw : d.raw, d.decimals),
        }));

    const lot = {
      txHash: tx.txHash,
      timestamp: tx.timestamp,
      blockNumber: tx.blockNumber,
      qty: units(moved.raw < 0n ? -moved.raw : moved.raw, moved.decimals),
    };

    if (moved.raw > 0n) acquisitions.push({ ...lot, paid: side(-1) });
    else disposals.push({ ...lot, received: side(1) });
  }

  // Undated entries sort last rather than pretending to be the oldest, which
  // would corrupt FIFO order.
  const byTime = (a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity);
  return { acquisitions: acquisitions.sort(byTime), disposals: disposals.sort(byTime) };
}

/**
 * Consume acquisitions oldest-first against disposals.
 *
 * FIFO rather than average cost because it is what a tax authority and every
 * exchange statement assume, and because it keeps each remaining lot traceable to
 * the transaction that created it.
 *
 * A lot with `costUsd == null` (an airdrop, or a leg with no price) stays
 * unpriced all the way through: consuming it produces realised quantity with no
 * realised gain, rather than a gain equal to the whole proceeds.
 */
export function matchFifo(acquisitions, disposals) {
  const open = acquisitions.map((a) => ({ ...a, left: a.qty }));
  const realized = [];

  for (const disposal of disposals) {
    let toMatch = disposal.qty;
    const consumed = [];
    for (const lot of open) {
      if (toMatch <= 1e-18) break;
      if (lot.left <= 1e-18) continue;
      const take = Math.min(lot.left, toMatch);
      lot.left -= take;
      toMatch -= take;
      consumed.push({
        txHash: lot.txHash,
        timestamp: lot.timestamp,
        qty: take,
        costUsd: lot.costUsd == null ? null : (lot.costUsd * take) / lot.qty,
      });
    }
    const costKnown = consumed.length > 0 && consumed.every((c) => c.costUsd != null);
    const cost = costKnown ? consumed.reduce((s, c) => s + c.costUsd, 0) : null;
    realized.push({
      txHash: disposal.txHash,
      timestamp: disposal.timestamp,
      qty: disposal.qty,
      // Quantity sold that no acquisition accounts for: history is incomplete.
      unmatchedQty: toMatch > 1e-12 ? toMatch : 0,
      proceedsUsd: disposal.proceedsUsd ?? null,
      costUsd: cost,
      gainUsd: cost != null && disposal.proceedsUsd != null ? disposal.proceedsUsd - cost : null,
      received: disposal.received,
    });
  }

  return { open: open.filter((lot) => lot.left > 1e-18), realized };
}

/**
 * Roll the open lots up into the figures a holder actually asks for: what did
 * this cost me, what is it worth, and what price do I need to break even.
 *
 * Quantity with an unknown basis is reported separately and excluded from the
 * average. Mixing it in would understate the average cost and overstate the gain,
 * which is the exact error this whole module exists to avoid.
 */
export function summarise(open, { balance = null, priceUsd = null } = {}) {
  let qtyPriced = 0;
  let costUsd = 0;
  let qtyUnpriced = 0;

  for (const lot of open) {
    if (lot.costUsd == null) qtyUnpriced += lot.left;
    else {
      qtyPriced += lot.left;
      costUsd += (lot.costUsd * lot.left) / lot.qty;
    }
  }

  const heldQty = balance ?? qtyPriced + qtyUnpriced;
  const valueUsd = priceUsd != null ? heldQty * priceUsd : null;
  const pricedValueUsd = priceUsd != null ? qtyPriced * priceUsd : null;

  return {
    qtyPriced,
    qtyUnpriced,
    costUsd: qtyPriced > 0 ? costUsd : null,
    avgCostUsd: qtyPriced > 0 ? costUsd / qtyPriced : null,
    // Break-even is the average cost: the price at which the priced lots return
    // exactly what they cost. Gas is not in it.
    breakEvenUsd: qtyPriced > 0 ? costUsd / qtyPriced : null,
    valueUsd,
    // Gain is computed only over the lots that have a cost, so an airdropped
    // remainder cannot inflate it.
    gainUsd: qtyPriced > 0 && pricedValueUsd != null ? pricedValueUsd - costUsd : null,
    gainPct: qtyPriced > 0 && pricedValueUsd != null && costUsd > 0
      ? pricedValueUsd / costUsd - 1
      : null,
  };
}
