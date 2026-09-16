import * as addressBook from "@bgd-labs/aave-address-book";
import { CHAINS } from "./chains.js";

/**
 * Every Aave v3 Core-market reserve on the chains in scope, from
 * @bgd-labs/aave-address-book. A build-time dependency rather than a runtime
 * call, so reserve discovery costs nothing and cannot rate-limit.
 *
 * Only the Core market is included, matching the pool index in llama.js: the
 * Prime / Horizon / Lido / EtherFi instances are separate markets with their own
 * aToken addresses and their own rates.
 */
export function reservesFor(chainId) {
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`Chain ${chainId} not in scope`);

  const market = addressBook[chain.market];
  if (!market?.ASSETS) throw new Error(`No ASSETS in address book for ${chain.market}`);

  return Object.entries(market.ASSETS)
    .filter(([, asset]) => asset.A_TOKEN && asset.UNDERLYING)
    .map(([symbol, asset]) => ({
      chainId,
      symbol,
      decimals: asset.decimals,
      underlying: asset.UNDERLYING.toLowerCase(),
      aToken: asset.A_TOKEN.toLowerCase(),
      vToken: asset.V_TOKEN?.toLowerCase() ?? null,
    }));
}

export const allReserves = () => CHAINS.flatMap((c) => reservesFor(c.id));

/** aToken address -> reserve, for attributing a balance row to a position. */
export function aTokenIndex() {
  const index = new Map();
  for (const reserve of allReserves()) index.set(`${reserve.chainId}:${reserve.aToken}`, reserve);
  return index;
}
