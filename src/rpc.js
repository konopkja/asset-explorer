import { chainById } from "./chains.js";

/**
 * Live `balanceOf` reads over public JSON-RPC.
 *
 * This exists because of a real, measured failure. An explorer's *indexed* token
 * balance is maintained from Transfer events, and aTokens rebase: interest lands
 * in the balance with no Transfer emitted. So an explorer balance drifts below
 * the truth on any position that has not been touched recently, and since
 *
 *   interest = balance - netPrincipal
 *
 * an understated balance drags the computed interest down and can push it
 * negative. Observed on a real Base USDC position: explorer said 1069.187389
 * aUSDC, the contract said 1203.582362, against net principal of 1141.105387.
 * That is the difference between reporting a 71.92 USDC loss and a 62.48 gain on
 * a position that only ever earned.
 *
 * Balances that matter are therefore read from the chain, never from the index.
 *
 * All four endpoints are official public RPCs that answer with
 * `access-control-allow-origin: *`, so this same file works in Node and in a
 * browser page loaded from `file://`.
 */

/** keccak256("balanceOf(address)")[0:4] */
const BALANCE_OF = "0x70a08231";
/** keccak256("scaledBalanceOf(address)")[0:4] — Aave's stored, interest-free balance */
const SCALED_BALANCE_OF = "0x1da24f3e";

let rpcRequests = 0;
export const getRpcRequestCount = () => rpcRequests;
export const resetRpcRequestCount = () => {
  rpcRequests = 0;
};

/**
 * `balanceOf(user)` for many tokens on one chain, in a single JSON-RPC batch.
 *
 * Falls back to sequential calls if the endpoint rejects batching, and returns
 * whatever it could read: a token missing from the result simply has no live
 * balance, and the caller decides what to do about that rather than getting a
 * silent zero.
 */
export const balanceOfBatch = (chainId, tokens, user) =>
  callBatch(chainId, tokens, BALANCE_OF, user);

/**
 * `scaledBalanceOf(user)` for many aTokens at once. Used to verify that a
 * position's event set is complete: the scaled balance moves only when
 * principal moves, so it can be rebuilt from events and compared with the
 * contract.
 */
export const scaledBalanceOfBatch = (chainId, tokens, user) =>
  callBatch(chainId, tokens, SCALED_BALANCE_OF, user);

async function callBatch(chainId, tokens, selector, user) {
  const out = new Map();
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (unique.length === 0) return out;

  const chain = chainById(chainId);
  if (!chain?.rpc) return out;

  const data = selector + user.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const payload = unique.map((token, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: token, data }, "latest"],
  }));

  const post = async (body) => {
    rpcRequests += 1;
    const res = await fetch(chain.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    return res.json();
  };

  const take = (token, result) => {
    if (typeof result === "string" && result !== "0x") {
      try {
        out.set(token, BigInt(result));
      } catch {
        /* unparseable result is treated as no answer */
      }
    }
  };

  try {
    const body = await post(payload);
    if (!Array.isArray(body)) throw new Error("batch not supported");
    for (const row of body) take(unique[row.id], row.result);
    if (out.size > 0) return out;
  } catch {
    /* fall through to one call per token */
  }

  for (const token of unique) {
    try {
      const body = await post(payload.find((p) => p.params[0].to === token));
      take(token, body?.result);
    } catch {
      /* leave this token unanswered */
    }
  }
  return out;
}
