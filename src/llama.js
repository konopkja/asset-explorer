import { CHAINS, NATIVE_COIN } from "./chains.js";

const HEADERS = { "User-Agent": "curl/8.7.1", Accept: "application/json" };

async function getJson(url, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`DefiLlama request failed: ${lastError?.message}`);
}

/** Pool index key. The market belongs in it: see fetchAavePoolIndex. */
export const poolKey = (chainId, underlying, market) =>
  `${chainId}:${underlying.toLowerCase()}:${market}`;

/**
 * Map (chainId, underlying token, market) -> DefiLlama pool id for Aave v3
 * supply pools.
 *
 * Two traps here, both silent:
 *
 * 1. DefiLlama names Optimism "OP Mainnet". Filtering on "Optimism" returns zero
 *    pools, which is indistinguishable from Aave not being deployed there.
 * 2. Several Aave markets share one underlying on Ethereum: Core, "Prime
 *    Instance", "Aave Horizon Market", "Umbrella", "Legacy". They have different
 *    rates AND different aToken addresses, so the market has to be part of the
 *    key: indexing on the underlying alone compares a position against whichever
 *    market happened to be written last, which is a plausible wrong number rather
 *    than a visible failure. The mapping from a market to its `poolMeta` string
 *    lives in chains.js; "Umbrella" and "Legacy" are unmapped and therefore
 *    ignored, since neither is a market this tool reads positions from.
 */
export async function fetchAavePoolIndex() {
  const body = await getJson("https://yields.llama.fi/pools");
  const byChainName = new Map(CHAINS.map((c) => [c.llamaYield, c.id]));
  // (chainId, poolMeta) -> market name, built only from markets that declare one.
  const marketByMeta = new Map();
  for (const chain of CHAINS) {
    for (const market of chain.markets) {
      if (!("llamaPoolMeta" in market)) continue;
      marketByMeta.set(`${chain.id}:${market.llamaPoolMeta}`, market.name);
    }
  }
  const index = new Map();

  for (const pool of body.data ?? []) {
    if (pool.project !== "aave-v3") continue;
    const chainId = byChainName.get(pool.chain);
    if (chainId === undefined) continue;
    const market = marketByMeta.get(`${chainId}:${pool.poolMeta ?? null}`);
    if (market === undefined) continue; // a market we do not read positions from
    for (const token of pool.underlyingTokens ?? []) {
      const key = poolKey(chainId, token, market);
      const existing = index.get(key);
      // Deterministic tie-break: deepest market wins.
      if (!existing || (pool.tvlUsd ?? 0) > (existing.tvlUsd ?? 0)) {
        index.set(key, {
          poolId: pool.pool,
          symbol: pool.symbol,
          apyNow: pool.apyBase ?? pool.apy ?? null,
          tvlUsd: pool.tvlUsd ?? null,
        });
      }
    }
  }
  return index;
}

/**
 * Daily APY history for one pool. Rows carry apyBase (the lending rate) apart
 * from apyReward (incentives), and we compare against apyBase because reward
 * tokens are not counted in our own interest figure either.
 */
export async function fetchApyHistory(poolId) {
  const body = await getJson(`https://yields.llama.fi/chart/${poolId}`);
  return (body.data ?? [])
    .map((row) => ({
      timestamp: Math.floor(Date.parse(row.timestamp) / 1000),
      apyBase: row.apyBase ?? row.apy ?? null,
      apyReward: row.apyReward ?? null,
      tvlUsd: row.tvlUsd ?? null,
    }))
    .filter((row) => Number.isFinite(row.timestamp) && row.apyBase != null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

const priceKey = (chainId, address) => {
  const chain = CHAINS.find((c) => c.id === chainId);
  return `${chain?.llamaPrice ?? "ethereum"}:${address.toLowerCase()}`;
};

/**
 * Spot prices for many (chain, token) pairs in one call.
 * `confidence` is passed through: anything DefiLlama is unsure about must render
 * as a gap rather than as a confident number.
 */
export async function fetchPrices(tokens) {
  if (tokens.length === 0) return new Map();
  const out = new Map();
  // The endpoint takes a comma-separated list; keep batches modest so one bad
  // token cannot fail an enormous request.
  for (let i = 0; i < tokens.length; i += 80) {
    const batch = tokens.slice(i, i + 80);
    const coins = batch.map((t) => priceKey(t.chainId, t.address)).join(",");
    const body = await getJson(`https://coins.llama.fi/prices/current/${coins}`);
    for (const [key, value] of Object.entries(body.coins ?? {})) {
      out.set(key.toLowerCase(), {
        price: value.price,
        symbol: value.symbol,
        decimals: value.decimals,
        confidence: value.confidence ?? null,
      });
    }
  }
  return out;
}

export const lookupPrice = (prices, chainId, address) =>
  prices.get(priceKey(chainId, address).toLowerCase()) ?? null;

/**
 * Historical prices for many (token, moment) pairs in ONE request.
 *
 * Cost basis needs a price at the moment of every trade, and the obvious
 * endpoint (`prices/historical/{ts}/{coins}`) takes one timestamp, so a wallet
 * with forty trades on forty days would pay forty round trips. `batchHistorical`
 * takes a map of coin -> list of timestamps instead, which collapses the whole
 * report into a single call.
 *
 * DefiLlama answers with the nearest price it has rather than the exact instant,
 * so the reply is matched back by proximity and anything outside the search
 * window is dropped rather than snapped to a distant price.
 */
const SEARCH_WIDTH = 600; // seconds either side, matching the endpoint's default

export const historicalKey = (coin, timestamp) => `${coin.toLowerCase()}@${timestamp}`;

/** `address: null` means the chain's native coin. */
export const coinId = (chainId, address) => {
  if (address == null) return NATIVE_COIN;
  const chain = CHAINS.find((c) => c.id === chainId);
  return `${chain?.llamaPrice ?? "ethereum"}:${address.toLowerCase()}`;
};

export async function fetchHistoricalPrices(requests) {
  const wanted = new Map(); // coin -> Set of timestamps
  for (const r of requests) {
    if (r.timestamp == null) continue;
    const coin = coinId(r.chainId, r.address);
    if (!wanted.has(coin)) wanted.set(coin, new Set());
    wanted.get(coin).add(r.timestamp);
  }
  const out = new Map();
  if (wanted.size === 0) return out;

  // Chunked so one enormous URL cannot fail the whole report.
  const coins = [...wanted.entries()];
  for (let i = 0; i < coins.length; i += 25) {
    const batch = Object.fromEntries(
      coins.slice(i, i + 25).map(([coin, stamps]) => [coin, [...stamps]]),
    );
    let body;
    try {
      body = await getJson(
        `https://coins.llama.fi/batchHistorical?coins=${encodeURIComponent(JSON.stringify(batch))}` +
          `&searchWidth=${SEARCH_WIDTH}`,
      );
    } catch {
      continue; // those lots stay unpriced, which the report says out loud
    }
    for (const [coin, data] of Object.entries(body?.coins ?? {})) {
      const points = data?.prices ?? [];
      if (points.length === 0) continue;
      for (const stamp of batch[coin] ?? []) {
        let best = null;
        for (const point of points) {
          const gap = Math.abs(point.timestamp - stamp);
          if (gap <= SEARCH_WIDTH && (best === null || gap < best.gap)) {
            best = { gap, price: point.price, confidence: point.confidence ?? null };
          }
        }
        if (best) {
          out.set(historicalKey(coin, stamp), { price: best.price, confidence: best.confidence });
        }
      }
    }
  }
  return out;
}

export const lookupHistorical = (prices, chainId, address, timestamp) =>
  prices.get(historicalKey(coinId(chainId, address), timestamp)) ?? null;
