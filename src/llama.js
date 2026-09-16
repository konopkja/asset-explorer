import { CHAINS } from "./chains.js";

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

/**
 * Map (chainId, underlying token) -> DefiLlama pool id for Aave v3 supply pools.
 *
 * Two traps here, both silent:
 *
 * 1. DefiLlama names Optimism "OP Mainnet". Filtering on "Optimism" returns zero
 *    pools, which is indistinguishable from Aave not being deployed there.
 * 2. Several Aave markets share one underlying on Ethereum: Core, "Prime
 *    Instance", "Aave Horizon Market", "Umbrella", "Legacy". They have different
 *    rates AND different aToken addresses. `poolMeta === null` is the Core
 *    market, which is the one @bgd-labs/aave-address-book's AaveV3Ethereum
 *    describes, so that is the only one we may compare against. Picking the
 *    wrong one quietly compares your position to a different market's APY.
 */
export async function fetchAavePoolIndex() {
  const body = await getJson("https://yields.llama.fi/pools");
  const byChainName = new Map(CHAINS.map((c) => [c.llamaYield, c.id]));
  const index = new Map();

  for (const pool of body.data ?? []) {
    if (pool.project !== "aave-v3") continue;
    const chainId = byChainName.get(pool.chain);
    if (chainId === undefined) continue;
    if (pool.poolMeta != null) continue; // non-Core market
    for (const token of pool.underlyingTokens ?? []) {
      const key = `${chainId}:${token.toLowerCase()}`;
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
