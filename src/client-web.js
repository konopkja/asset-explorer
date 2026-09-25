import { CHAINS, chainById } from "./chains.js";

/**
 * Browser scan client: the keyless public Blockscout instances.
 *
 * These serve `access-control-allow-origin: *`, which is the whole reason a
 * single HTML file can do the entire scan with no server and no secret. The
 * trade against the CLI's Pro host is rate limits, so requests are paced and the
 * transfer sweep has a smaller page budget.
 *
 * `RESERVES` is injected by the build (the Aave address book is a Node package,
 * so its output is baked in as data rather than fetched).
 */

const PACE_MS = 60;

let requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const host = (chainId) => chainById(chainId).explorer;

async function request(url, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Paced rather than bursted: these are free public endpoints.
    await sleep(attempt === 0 ? PACE_MS : 500 * 2 ** (attempt - 1));
    requests += 1;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Request failed after ${attempts} attempts: ${lastError?.message}`);
}

const toNumber = (value) => {
  if (typeof value === "number") return value;
  if (value == null || value === "0x") return 0;
  const s = String(value);
  return s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
};

/**
 * Per-transaction log cache. A single transaction commonly touches several
 * positions at once (a leveraged loop supplies one asset and borrows another),
 * so fetching its logs once and reusing them across positions is what keeps the
 * request count near the number of transactions rather than a multiple of it.
 */
const txLogCache = new Map();

/**
 * Transaction timestamps harvested from the transfer sweep.
 *
 * Older Blockscout releases omit `block_timestamp` from the logs endpoint
 * (Linea's instance does; Base's does not), and every time-weighted metric
 * filters out undated ledger entries, so an undated chain would silently report
 * no IRR, no TWR and no pool comparison rather than an error. The sweep already
 * returns a dated row for every transaction whose logs are later fetched, so the
 * missing field costs no extra request.
 */
const txTimestamps = new Map();

const rememberTimestamps = (chainId, transfers) => {
  for (const t of transfers) {
    if (t.txHash && t.timestamp) txTimestamps.set(`${chainId}:${t.txHash}`, t.timestamp);
  }
};

async function logsForTx(chainId, hash) {
  const key = `${chainId}:${hash}`;
  if (txLogCache.has(key)) return txLogCache.get(key);

  const body = await request(`${host(chainId)}/api/v2/transactions/${hash}/logs`);
  const logs = (body?.items ?? []).map((item) => ({
    blockNumber: toNumber(item.block_number),
    logIndex: toNumber(item.index),
    transactionHash: hash,
    address: (item.address?.hash ?? item.address ?? "").toLowerCase(),
    data: item.data,
    topics: (item.topics ?? []).filter((t) => typeof t === "string"),
    timestamp: item.block_timestamp
      ? Math.floor(Date.parse(item.block_timestamp) / 1000)
      : txTimestamps.get(key) ?? null,
  }));
  txLogCache.set(key, logs);
  return logs;
}

/**
 * A position's events, read one transaction at a time.
 *
 * The public instances serve every v2 REST endpoint happily but rate-limit the
 * etherscan-compatible `/api?module=logs` endpoint hard, so the CLI's four
 * topic-filtered queries are not available here. Instead the transfer sweep
 * already identified every transaction that changed this position: Aave emits a
 * zero-address `Transfer` alongside every `Mint` and `Burn`, so a token transfer
 * exists for every balance change. Fetching those transactions' logs and
 * filtering to this aToken yields exactly the same event set.
 *
 * Cost is one request per transaction, minus cache hits, which is proportional
 * to real activity rather than to chain history.
 */
async function getPositionLogs(chainId, { aToken, txHashes = [] }) {
  const wanted = aToken.toLowerCase();
  const out = [];
  for (const hash of txHashes) {
    const logs = await logsForTx(chainId, hash);
    for (const log of logs) if (log.address === wanted) out.push(log);
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

async function getTokenBalances(chainId, address) {
  const rows = await request(`${host(chainId)}/api/v2/addresses/${address}/token-balances`);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row.token?.type === "ERC-20")
    .map((row) => ({
      address: (row.token.address_hash ?? row.token.address ?? "").toLowerCase(),
      symbol: row.token.symbol,
      name: row.token.name,
      decimals: toNumber(row.token.decimals),
      raw: BigInt(row.value),
      priceUsd: row.token.exchange_rate != null ? Number(row.token.exchange_rate) : null,
      reputation: row.token.reputation ?? null,
      holders: toNumber(row.token.holders_count ?? 0),
    }));
}

/** Session-scoped sweep cache, the browser counterpart of the CLI's disk cache. */
function readCache(chainId, address) {
  try {
    const raw = sessionStorage.getItem(`yl:sweep:${chainId}:${address}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      lastBlock: parsed.lastBlock ?? 0,
      truncated: !!parsed.truncated,
      transfers: (parsed.transfers ?? []).map((t) => ({ ...t, raw: BigInt(t.raw ?? 0) })),
    };
  } catch {
    return null;
  }
}

function writeCache(chainId, address, transfers, truncated) {
  try {
    const lastBlock = transfers.reduce((m, t) => Math.max(m, t.blockNumber), 0);
    sessionStorage.setItem(
      `yl:sweep:${chainId}:${address}`,
      JSON.stringify({
        lastBlock,
        truncated,
        transfers: transfers.map((t) => ({ ...t, raw: t.raw.toString() })),
      }),
    );
  } catch {
    /* quota exceeded on a huge wallet: a cold cache next time is not an error */
  }
}

async function getTokenTransfers(chainId, address, { maxPages = 60 } = {}) {
  const cached = readCache(chainId, address);
  const stopBelow = cached ? cached.lastBlock : null;

  const transfers = [];
  let params = null;
  let pages = 0;
  let truncated = false;
  let caughtUp = false;

  for (;;) {
    if (caughtUp) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const query = new URLSearchParams({ type: "ERC-20" });
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value != null) query.set(key, String(value));
    }
    const body = await request(
      `${host(chainId)}/api/v2/addresses/${address}/token-transfers?${query}`,
    );
    pages += 1;

    for (const item of body?.items ?? []) {
      if (item.token?.type !== "ERC-20") continue;
      if (stopBelow != null && toNumber(item.block_number) < stopBelow) {
        caughtUp = true;
        break;
      }
      transfers.push({
        token: (item.token.address_hash ?? item.token.address ?? "").toLowerCase(),
        symbol: item.token.symbol,
        decimals: toNumber(item.token.decimals),
        blockNumber: toNumber(item.block_number),
        timestamp: item.timestamp ? Math.floor(Date.parse(item.timestamp) / 1000) : null,
        from: (item.from?.hash ?? "").toLowerCase(),
        to: (item.to?.hash ?? "").toLowerCase(),
        raw: BigInt(item.total?.value ?? 0),
        txHash: item.transaction_hash,
      });
    }

    if (!body?.next_page_params) break;
    params = body.next_page_params;
  }

  const seen = new Set();
  const merged = [];
  for (const t of transfers.concat(cached?.transfers ?? [])) {
    const key = `${t.txHash}-${t.token}-${t.from}-${t.to}-${t.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  merged.sort((a, b) => a.blockNumber - b.blockNumber);

  const stillTruncated = truncated || Boolean(cached?.truncated);
  writeCache(chainId, address, merged, stillTruncated);
  rememberTimestamps(chainId, merged);
  return { transfers: merged, truncated: stillTruncated, pages };
}

/**
 * Every transaction in which ETH itself moved in or out of the wallet.
 *
 * Cost basis reads a swap from the wallet's net position change, and a swap
 * funded with ETH has no ERC-20 leg on the paying side, so without this an
 * ETH-funded buy looks like a gift. Two paginated address endpoints cover it:
 * `transactions` carries the value the wallet sent directly, and
 * `internal-transactions` carries ETH a contract sent back, which is how a sale
 * for ETH arrives.
 *
 * Paginated per ADDRESS rather than fetched per transaction. The per-transaction
 * route is what the public instances rate-limit into the ground: a probe that
 * fetched roughly a hundred single transactions took a 429 and stayed limited for
 * minutes, while a paged address sweep of the same history is a handful of calls.
 */
async function getNativeMoves(chainId, address, { maxPages = 8 } = {}) {
  const owner = address.toLowerCase();
  const moves = new Map();
  let truncated = false;

  const walk = async (path, sign, fixed = {}) => {
    let params = null;
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) {
        truncated = true;
        return;
      }
      const query = new URLSearchParams(fixed);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value != null) query.set(key, String(value));
      }
      let body;
      try {
        body = await request(`${host(chainId)}/api/v2/addresses/${address}/${path}?${query}`);
      } catch {
        // Native legs are an enrichment: losing them costs cost-basis coverage on
        // ETH-funded trades, which the report labels, and nothing else.
        truncated = true;
        return;
      }
      for (const item of body?.items ?? []) {
        let raw;
        try {
          raw = BigInt(item.value ?? 0);
        } catch {
          continue;
        }
        if (raw === 0n) continue;
        const hash = item.transaction_hash ?? item.hash;
        if (!hash) continue;
        const from = (item.from?.hash ?? "").toLowerCase();
        const to = (item.to?.hash ?? "").toLowerCase();
        // `sign` fixes the direction for the outgoing-transaction list, where the
        // wallet is always the sender; internal rows are read from their own ends.
        let delta = 0n;
        if (sign !== 0) delta = raw * BigInt(sign);
        else if (to === owner && from !== owner) delta = raw;
        else if (from === owner && to !== owner) delta = -raw;
        if (delta === 0n) continue;
        moves.set(hash, (moves.get(hash) ?? 0n) + delta);
      }
      if (!body?.next_page_params) return;
      params = body.next_page_params;
    }
  };

  // filter=from is the wallet's own sends, so every row is ETH leaving.
  await walk("transactions", -1, { filter: "from" });
  await walk("internal-transactions", 0);
  return { moves, truncated };
}

async function getNativeBalance(chainId, address) {
  const body = await request(`${host(chainId)}/api/v2/addresses/${address}`);
  return BigInt(body?.coin_balance ?? 0);
}

/**
 * Resolve an ENS name, or pass an address through.
 *
 * The search endpoint matches token names as well as ENS domains and returns
 * them in one list, so "usdc.eth" comes back with tokens whose names contain the
 * string. Only `type === "ens_domain"` rows count, and an exact name match is
 * preferred, or the scan would silently run against a token contract.
 */
export async function resolveAddress(input) {
  const trimmed = String(input ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { address: trimmed.toLowerCase(), ens: null };

  const body = await request(
    `${host(1)}/api/v2/search?q=${encodeURIComponent(trimmed)}`,
  );
  const wanted = trimmed.toLowerCase();
  const domains = (body?.items ?? []).filter((i) => i.type === "ens_domain");
  const exact = domains.find((i) => (i.ens_info?.name ?? i.name ?? "").toLowerCase() === wanted);
  const hit = exact ?? domains[0];
  const found = hit?.ens_info?.address_hash ?? hit?.address_hash ?? hit?.address;

  if (!found) throw new Error(`Could not resolve "${trimmed}". Use an ENS name or a 0x address.`);
  return {
    address: found.toLowerCase(),
    ens: hit.ens_info?.name ?? hit.name ?? null,
    inexact: !exact,
  };
}

/** RESERVES is baked in by the build; see build-web.js. */
const reservesFor = (chainId) => (typeof RESERVES === "undefined" ? [] : RESERVES[chainId] ?? []);

export const webClient = {
  getPositionLogs,
  getTokenBalances,
  getTokenTransfers,
  getNativeMoves,
  getNativeBalance,
  reservesFor,
  requestCount: () => requests,
  resetRequestCount: () => {
    requests = 0;
  },
};

export { CHAINS };
