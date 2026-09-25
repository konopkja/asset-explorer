import { CHAINS, chainById } from "./chains.js";
import {
  buildLedger,
  accruedInterest,
  realizedInterest,
  netPrincipal,
  reconstructedScaled,
} from "./ledger.js";
import {
  xirr,
  poolTwr,
  positionCashflows,
  timeWeightedPrincipal,
  balanceSeries,
  interestSeries,
  toUnits,
} from "./metrics.js";
import {
  fetchAavePoolIndex,
  fetchApyHistory,
  fetchPrices,
  fetchHistoricalPrices,
  lookupPrice,
  lookupHistorical,
  poolKey,
} from "./llama.js";
import { transactionDeltas, lotsForToken, matchFifo, summarise } from "./basis.js";
import {
  balanceOfBatch,
  scaledBalanceOfBatch,
  getRpcRequestCount,
  resetRpcRequestCount,
} from "./rpc.js";

/**
 * Scan orchestration. Everything environment-specific is injected as a `client`,
 * so this file has no opinion about where the data comes from:
 *
 *   getPositionLogs(chainId, { aToken, user, fromBlock, txHashes }) -> logs
 *   getTokenBalances(chainId, address)                -> balance rows
 *   getTokenTransfers(chainId, address)               -> { transfers, truncated, pages }
 *   getNativeBalance(chainId, address)                -> BigInt
 *   reservesFor(chainId)                              -> reserve list
 *   requestCount()                                    -> number
 *
 * The shipped client is src/client-web.js, reading the keyless public explorer
 * instances from the browser.
 */

/**
 * Reduce a transfer sweep to "which tokens did this address ever touch, and from
 * which block", which is what bounds the per-position event scans.
 */
export function tokensTouched(transfers) {
  const index = new Map();
  for (const t of transfers) {
    const existing = index.get(t.token);
    if (!existing) {
      index.set(t.token, {
        token: t.token,
        symbol: t.symbol,
        firstBlock: t.blockNumber,
        count: 1,
        // Every Aave Mint and Burn is accompanied by a zero-address Transfer, so
        // the sweep sees every transaction that changed the position. Keeping the
        // hashes lets a client that cannot run a topic-filtered log query fetch
        // those transactions' logs directly instead.
        txHashes: new Set(t.txHash ? [t.txHash] : []),
      });
    } else {
      existing.firstBlock = Math.min(existing.firstBlock, t.blockNumber);
      existing.count += 1;
      if (t.txHash) existing.txHashes.add(t.txHash);
    }
  }
  return index;
}

/**
 * Spam and dust filter for the balance view.
 *
 * Blockscout's own `reputation` field is NOT a usable spam signal: it reads "ok"
 * for tokens with a 100-billion supply, no price and no market. What actually
 * separates a holding from spam is whether an independent pricing source knows
 * the token at all, and then whether the position is worth more than a dollar.
 * Reputation is kept only as a veto for confirmed scams.
 */
function isRealHolding(row, priceInfo) {
  if (row.reputation === "scam") return false;
  const price = priceInfo?.price ?? row.priceUsd;
  if (price == null || !(price > 0)) return false;
  const value = toUnits(row.raw, row.decimals) * price;
  return value >= 1;
}

export async function scanChain(client, chainId, user, poolIndex, { onProgress = () => {} } = {}) {
  const chain = chainById(chainId);
  const reserves = client.reservesFor(chainId);
  const asOf = Math.floor(Date.now() / 1000);

  onProgress(`${chain.name}: reading transfer history`);
  const sweep = await client.getTokenTransfers(chainId, user);
  const touched = tokensTouched(sweep.transfers);

  onProgress(`${chain.name}: reading balances`);
  const balanceRows = await client.getTokenBalances(chainId, user);

  // ETH legs of swaps, which are not ERC-20 transfers and so are invisible to the
  // sweep. Only cost basis needs them, and a client may not offer them at all.
  const native = client.getNativeMoves
    ? await client.getNativeMoves(chainId, user)
    : { moves: new Map(), truncated: true };
  const balanceByToken = new Map(balanceRows.map((row) => [row.address, row]));

  // A reserve is a candidate if its aToken was ever transferred (covers closed
  // positions) or currently has a balance (covers a position opened by a route
  // the transfer sweep truncated away).
  const candidates = reserves.filter(
    (reserve) => touched.has(reserve.aToken) || balanceByToken.has(reserve.aToken),
  );

  // aToken balances are read LIVE, never from the explorer's index. Explorers
  // maintain token balances from Transfer events, and aTokens rebase: interest
  // arrives with no Transfer emitted, so an indexed balance drifts below the
  // truth on any position not touched recently. Since interest = balance -
  // netPrincipal, that drift lands directly on the headline number and can make
  // a position that only ever earned look like a loss.
  const aTokens = candidates.map((r) => r.aToken);
  const [liveBalances, liveScaled] = await Promise.all([
    balanceOfBatch(chainId, aTokens, user),
    // The scaled balance is what proves the event set is complete: it moves only
    // when principal moves, so rebuilding it from events and comparing against
    // the contract catches a missing deposit or withdrawal that the balance
    // identity alone cannot, being built from those same events.
    scaledBalanceOfBatch(chainId, aTokens, user),
  ]);

  // Which tokens did this wallet actually trade? Computed here because it costs
  // nothing (the sweep is already in hand) and because scanAddress needs it
  // before the price call, so a token that was bought and then sold to zero can
  // still be priced and reported.
  const byTx = transactionDeltas(sweep.transfers, user);
  const tradedTokens = [];
  {
    const seen = new Map();
    for (const tx of byTx.values()) {
      const moved = [...tx.deltas.values()].filter((d) => d.raw !== 0n);
      if (moved.length < 2) continue; // nothing was exchanged for anything
      for (const d of moved) {
        if (!seen.has(d.token)) seen.set(d.token, { address: d.token, symbol: d.symbol, decimals: d.decimals });
      }
    }
    tradedTokens.push(...seen.values());
  }

  const positions = [];
  for (const reserve of candidates) {
    onProgress(`${chain.name}: ${reserve.symbol}`);
    const seen = touched.get(reserve.aToken);
    // How a position's events are fetched is the one thing that genuinely differs
    // between environments, so the client owns it: the CLI runs four
    // topic-filtered log queries, while the browser reads the logs of the
    // transactions the sweep already identified.
    const logs = await client.getPositionLogs(chainId, {
      aToken: reserve.aToken,
      user,
      fromBlock: Math.max(0, (seen?.firstBlock ?? 0) - 1),
      txHashes: seen ? [...seen.txHashes] : [],
    });
    const ledger = buildLedger(logs, user);
    if (ledger.length === 0) continue;

    // Fall back to the indexed balance only when the chain could not be read at
    // all, and record which source was used so the report can say so.
    const live = liveBalances.get(reserve.aToken);
    const balanceRaw = live ?? balanceByToken.get(reserve.aToken)?.raw ?? 0n;
    const balanceIsLive = live !== undefined;

    const onChainScaled = liveScaled.get(reserve.aToken);
    const ourScaled = reconstructedScaled(ledger);
    const scaledDrift = onChainScaled === undefined ? null : ourScaled - onChainScaled;
    // A wei or two of ray rounding is expected; anything more means an event is
    // missing and every figure on this position is suspect.
    const eventsComplete =
      scaledDrift === null
        ? null
        : (scaledDrift < 0n ? -scaledDrift : scaledDrift) <= BigInt(ledger.length + 1);
    const interestRaw = accruedInterest(balanceRaw, ledger);
    const realizedRaw = realizedInterest(ledger);
    const dated = ledger.filter((e) => e.timestamp);
    const firstTs = dated.length ? dated[0].timestamp : null;

    const pool = poolIndex.get(poolKey(chainId, reserve.underlying, reserve.market)) ?? null;
    let apyHistory = [];
    if (pool) {
      try {
        apyHistory = await fetchApyHistory(pool.poolId);
      } catch {
        apyHistory = []; // rate comparison renders as unavailable, never as zero
      }
    }

    const cashflows = positionCashflows(ledger, balanceRaw, reserve.decimals, asOf);
    const utilisation = timeWeightedPrincipal(ledger, reserve.decimals, asOf);

    positions.push({
      chainId,
      chainName: chain.name,
      market: reserve.market,
      symbol: reserve.symbol,
      decimals: reserve.decimals,
      underlying: reserve.underlying,
      aToken: reserve.aToken,
      isOpen: balanceRaw > 0n,
      balanceIsLive,
      eventsComplete,
      scaledDrift: scaledDrift === null ? null : toUnits(scaledDrift, reserve.decimals),
      balance: toUnits(balanceRaw, reserve.decimals),
      netPrincipal: toUnits(netPrincipal(ledger), reserve.decimals),
      interest: toUnits(interestRaw, reserve.decimals),
      realizedInterest: toUnits(realizedRaw, reserve.decimals),
      pendingInterest: toUnits(interestRaw - realizedRaw, reserve.decimals),
      interestIsNegative: interestRaw < 0n,
      firstTs,
      eventCount: ledger.length,
      myApy: xirr(cashflows),
      poolApy: firstTs ? poolTwr(apyHistory, firstTs, asOf) : null,
      poolApyNow: pool?.apyNow ?? null,
      poolId: pool?.poolId ?? null,
      utilisation,
      // Forward estimate: what this position earns per month at the rate the
      // pool is paying RIGHT NOW, on the balance it holds right now. Uses the
      // pool's live rate rather than your historical XIRR, because your past
      // timing says nothing about what the next month pays. The twelfth root
      // rather than a twelfth: apyBase already compounds, so dividing by 12
      // would overstate it.
      // Nulled when it would round to nothing, so a dust balance does not get a
      // solemn "0.0000/mo" forecast; the card falls back to capital deployed.
      monthlyEstimate: (() => {
        if (balanceRaw <= 0n || pool?.apyNow == null) return null;
        const monthly =
          toUnits(balanceRaw, reserve.decimals) * ((1 + pool.apyNow / 100) ** (1 / 12) - 1);
        // One base unit is a meaningless floor for an 18-decimal token, so the
        // test is whether the figure survives the precision it is shown at.
        return monthly >= 0.00005 ? monthly : null;
      })(),
      series: balanceSeries(ledger, balanceRaw, reserve.decimals, asOf),
      // Interest as it was really earned: continuous, not stepped at events.
      // The present index comes straight from the chain: balance / scaledBalance.
      interestCurve: interestSeries(
        ledger,
        reserve.decimals,
        asOf,
        onChainScaled && onChainScaled > 0n ? Number(balanceRaw) / Number(onChainScaled) : null,
      ),
      // Rate history trimmed to this position's window, with one point of lead-in
      // so the line starts at the left edge rather than inside the plot.
      apySeries: firstTs
        ? apyHistory.filter((row, i, all) => {
            const next = all[i + 1];
            return row.timestamp >= firstTs || (next && next.timestamp >= firstTs);
          })
        : [],
      ledger: ledger.map((entry) => ({
        action: entry.action,
        timestamp: entry.timestamp,
        principalDelta: toUnits(entry.principalDelta, reserve.decimals),
        interestRealized: toUnits(entry.interestRealized, reserve.decimals),
        txHash: entry.txHash,
        blockNumber: entry.blockNumber,
      })),
    });
  }

  return {
    chainId,
    name: chain.name,
    positions,
    balanceRows,
    nativeRaw: await client.getNativeBalance(chainId, user),
    sweep: { truncated: sweep.truncated, pages: sweep.pages, transfers: sweep.transfers.length },
    // Intermediates for the cost-basis pass in scanAddress, deleted before the
    // result is returned: both are Maps and neither belongs in the payload.
    transfers: sweep.transfers,
    nativeMoves: native,
    tradedTokens,
  };
}

export async function scanAddress(
  client,
  user,
  { chains = CHAINS, onProgress = () => {}, chainConcurrency = 1 } = {},
) {
  const started = Date.now();
  const asOf = Math.floor(Date.now() / 1000);

  resetRpcRequestCount();
  onProgress("fetching Aave rate history from DefiLlama");
  const poolIndex = await fetchAavePoolIndex();

  // Whether chains can run at once depends on the transport, so the client
  // decides. The CLI funnels all four through one Pro host and shares its rate
  // limit, so it stays sequential; the browser reads a different public explorer
  // per chain, where concurrency costs no single host anything.
  const limit = Math.max(1, Math.min(chainConcurrency, chains.length));
  const results = new Array(chains.length);
  let next = 0;
  const worker = async () => {
    while (next < chains.length) {
      const index = next;
      next += 1;
      results[index] = await scanChain(client, chains[index].id, user, poolIndex, { onProgress });
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));

  // One batched price call for everything worth pricing.
  onProgress("pricing holdings");
  const priceTargets = [];
  for (const result of results) {
    for (const row of result.balanceRows) {
      priceTargets.push({ chainId: result.chainId, address: row.address });
    }
    for (const position of result.positions) {
      priceTargets.push({ chainId: result.chainId, address: position.underlying });
    }
    for (const traded of result.tradedTokens ?? []) {
      priceTargets.push({ chainId: result.chainId, address: traded.address });
    }
  }
  let prices = new Map();
  try {
    prices = await fetchPrices(priceTargets);
  } catch {
    prices = new Map(); // USD columns render as unavailable
  }

  // Attach USD to positions and build the filtered holdings view.
  for (const result of results) {
    for (const position of result.positions) {
      const info = lookupPrice(prices, result.chainId, position.underlying);
      position.priceUsd = info?.price ?? null;
      position.priceConfidence = info?.confidence ?? null;
      position.balanceUsd = info?.price != null ? position.balance * info.price : null;
      position.interestUsd = info?.price != null ? position.interest * info.price : null;
      // A withdrawal that empties a position routinely leaves a few wei behind
      // (29 wei of aUSDC, on the position that prompted this), which is a
      // non-zero balance and so reads as open while displaying 0. Anything worth
      // under a cent is an exited position, and the report treats it as closed.
      // Left as a separate flag rather than folded into isOpen, because isOpen is
      // a fact about the chain and this is a judgement about presentation.
      position.isDust =
        position.isOpen && position.balanceUsd != null && position.balanceUsd < 0.01;
      position.monthlyEstimateUsd =
        info?.price != null && position.monthlyEstimate != null
          ? position.monthlyEstimate * info.price
          : null;
    }

    const chainReserves = client.reservesFor(result.chainId);
    const aTokens = new Set(chainReserves.map((r) => r.aToken));
    const debtTokens = new Map(chainReserves.filter((r) => r.vToken).map((r) => [r.vToken, r]));

    // Debt tokens are liabilities, not holdings. DefiLlama actually prices them
    // at a NEGATIVE price (variableDebtEthUSDe came back at -0.9997), so leaving
    // them in the holdings list would net silently against real assets. Borrow-
    // side accounting is out of scope, but the balances are surfaced so an open
    // loan is never invisible.
    result.debts = result.balanceRows
      .filter((row) => debtTokens.has(row.address))
      .map((row) => {
        const reserve = debtTokens.get(row.address);
        const info = lookupPrice(prices, result.chainId, reserve.underlying);
        const amount = toUnits(row.raw, row.decimals);
        return {
          symbol: reserve.symbol,
          amount,
          valueUsd: info?.price != null ? amount * Math.abs(info.price) : null,
        };
      })
      .filter((d) => d.amount > 0);

    const tradedAddresses = new Set((result.tradedTokens ?? []).map((t) => t.address));

    result.holdings = result.balanceRows
      .filter((row) => !aTokens.has(row.address) && !debtTokens.has(row.address))
      .map((row) => {
        const info = lookupPrice(prices, result.chainId, row.address);
        const price = info?.price ?? row.priceUsd;
        const amount = toUnits(row.raw, row.decimals);
        return {
          symbol: row.symbol,
          name: row.name,
          address: row.address,
          decimals: row.decimals,
          reputation: row.reputation,
          amount,
          priceUsd: price ?? null,
          valueUsd: price != null ? amount * price : null,
          confidence: info?.confidence ?? null,
          kept: isRealHolding(row, info),
        };
      })
      .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
    // A token you BOUGHT belongs in the report whatever it is worth now. The $1
    // floor exists to bury airdropped spam, and it was also burying a real trade:
    // 4.33 USDC of a token now worth one cent is a 99.8% loss, which is exactly
    // the thing the holder wants to know. Trading it is the signal spam cannot
    // fake, so it overrides the floor -- but never the scam veto.
    const heldAddresses = new Set(result.holdings.map((h) => h.address));
    for (const holding of result.holdings) {
      if (!holding.kept && tradedAddresses.has(holding.address) && holding.reputation !== "scam") {
        holding.kept = true;
        holding.keptBecauseTraded = true;
      }
    }

    // ...and a token bought and then sold down to nothing has no balance row at
    // all, so it would vanish entirely along with its realised profit or loss.
    for (const traded of result.tradedTokens ?? []) {
      if (heldAddresses.has(traded.address)) continue;
      if (aTokens.has(traded.address) || debtTokens.has(traded.address)) continue;
      const info = lookupPrice(prices, result.chainId, traded.address);
      result.holdings.push({
        symbol: traded.symbol,
        name: null,
        address: traded.address,
        decimals: traded.decimals,
        reputation: null,
        amount: 0,
        priceUsd: info?.price ?? null,
        valueUsd: 0,
        confidence: info?.confidence ?? null,
        kept: true,
        keptBecauseTraded: true,
        exited: true,
      });
    }

    result.hiddenHoldings = result.holdings.filter((h) => !h.kept).length;

    // Cost basis, from the wallet's own history: see src/basis.js. Only holdings
    // that survived the spam filter are worth reconstructing, and the whole pass
    // costs no explorer requests at all because the sweep already holds both legs
    // of every swap.
    const byTx = transactionDeltas(result.transfers ?? [], user);
    for (const holding of result.holdings) {
      if (!holding.kept) continue;
      holding.lots = lotsForToken(byTx, holding.address, {
        nativeDeltas: result.nativeMoves?.moves ?? new Map(),
      });
    }

    // balanceRows carries BigInts and is only an intermediate. Dropping it keeps
    // the payload JSON-serialisable and roughly halves the report size.
    delete result.balanceRows;
    result.nativeBalance = toUnits(result.nativeRaw, 18);
    delete result.nativeRaw;
  }

  // One batched historical-price call for every leg of every trade, across all
  // chains at once. Paid legs give the cost of a lot, received legs the proceeds
  // of a sale.
  onProgress("pricing your trades");
  const legRequests = [];
  for (const result of results) {
    for (const holding of result.holdings ?? []) {
      if (!holding.lots) continue;
      for (const lot of holding.lots.acquisitions) {
        for (const leg of lot.paid) {
          legRequests.push({ chainId: result.chainId, address: leg.token, timestamp: lot.timestamp });
        }
      }
      for (const lot of holding.lots.disposals) {
        for (const leg of lot.received) {
          legRequests.push({ chainId: result.chainId, address: leg.token, timestamp: lot.timestamp });
        }
      }
    }
  }
  let historical = new Map();
  try {
    historical = await fetchHistoricalPrices(legRequests);
  } catch {
    historical = new Map(); // every lot then reports an unknown basis, and says so
  }

  const valueLegs = (chainId, legs, timestamp) => {
    let total = 0;
    const priced = [];
    for (const leg of legs) {
      const info = lookupHistorical(historical, chainId, leg.token, timestamp);
      const usd = info?.price != null ? leg.qty * info.price : null;
      priced.push({ symbol: leg.symbol, qty: leg.qty, priceUsd: info?.price ?? null, valueUsd: usd });
      if (usd == null) total = null;
      else if (total != null) total += usd;
    }
    return { total: legs.length ? total : null, priced };
  };

  for (const result of results) {
    for (const holding of result.holdings ?? []) {
      const lots = holding.lots;
      delete holding.lots;
      if (!lots) continue;

      const acquisitions = lots.acquisitions.map((lot) => {
        const { total, priced } = valueLegs(result.chainId, lot.paid, lot.timestamp);
        return { ...lot, paid: priced, costUsd: total };
      });
      const disposals = lots.disposals.map((lot) => {
        const { total, priced } = valueLegs(result.chainId, lot.received, lot.timestamp);
        return { ...lot, received: priced, proceedsUsd: total };
      });

      const { open, realized } = matchFifo(acquisitions, disposals);
      // Realised result, which is the whole story for a token sold down to zero
      // and half of it for one partly sold. Proceeds are reported even when the
      // cost is unknown, because "sold for $21.88, cost unknown" is useful and
      // "no data" is not.
      const proceedsUsd = realized.length && realized.every((r) => r.proceedsUsd != null)
        ? realized.reduce((sum, r) => sum + r.proceedsUsd, 0)
        : null;
      const realizedGainUsd = realized.length && realized.every((r) => r.gainUsd != null)
        ? realized.reduce((sum, r) => sum + r.gainUsd, 0)
        : null;
      const summary = summarise(open, {
        balance: holding.amount,
        priceUsd: holding.priceUsd,
      });

      // An acquisition with no counter-leg is an airdrop, a claim, an exchange
      // withdrawal or your own other wallet. There can be hundreds of them on a
      // token that pays holders, and listing each one would bury the trades that
      // actually have a price, so they collapse into one line.
      const trades = acquisitions.filter((a) => a.paid.length > 0);
      const gifts = acquisitions.filter((a) => a.paid.length === 0);

      holding.basis = {
        ...summary,
        proceedsUsd,
        realizedGainUsd,
        // Cost basis can only be as complete as the sweep that fed it.
        truncated: result.sweep.truncated || !!result.nativeMoves?.truncated,
        trades: trades.map((t) => ({
          timestamp: t.timestamp,
          txHash: t.txHash,
          qty: t.qty,
          paid: t.paid,
          costUsd: t.costUsd,
          unitCostUsd: t.costUsd != null && t.qty > 0 ? t.costUsd / t.qty : null,
        })),
        received: gifts.length
          ? {
              count: gifts.length,
              qty: gifts.reduce((sum, g) => sum + g.qty, 0),
              firstTs: gifts[0].timestamp ?? null,
              lastTs: gifts[gifts.length - 1].timestamp ?? null,
            }
          : null,
        sales: realized.map((r) => ({
          timestamp: r.timestamp,
          txHash: r.txHash,
          qty: r.qty,
          received: r.received,
          proceedsUsd: r.proceedsUsd,
          costUsd: r.costUsd,
          gainUsd: r.gainUsd,
          unmatchedQty: r.unmatchedQty,
        })),
      };
    }
    // Trading a token is a strong signal it is not spam, but on its own it lets in
    // two kinds of noise, both visible on a real wallet:
    //
    //   - The unit of account. Every swap has USDC on one side, so USDC looks like
    //     something bought 12 times and sold 20 times. Its cost basis is its face
    //     value and the line says nothing. Detected from the price rather than a
    //     hardcoded list, so a depegged stable still shows.
    //   - Trades too small to matter: a spam token received and dumped for 31
    //     cents is still spam.
    result.holdings = result.holdings.filter((holding) => {
      if (!holding.keptBecauseTraded) return true;
      if (holding.priceUsd != null && Math.abs(holding.priceUsd - 1) < 0.01) return false;
      const traded = (holding.basis?.costUsd ?? 0) + (holding.basis?.proceedsUsd ?? 0);
      return traded >= 1;
    });
    result.hiddenHoldings = result.holdings.filter((h) => !h.kept).length;

    delete result.transfers;
    delete result.nativeMoves;
  }

  return {
    address: user,
    asOf,
    chains: results,
    stats: {
      requests: client.requestCount() + getRpcRequestCount(),
      durationMs: Date.now() - started,
    },
  };
}
