import * as addressBook from "@bgd-labs/aave-address-book";
import { CHAINS } from "./chains.js";

/**
 * Every Aave v3 reserve on the chains in scope, across every market instance
 * listed in chains.js, from @bgd-labs/aave-address-book. A build-time dependency
 * rather than a runtime call, so reserve discovery costs nothing and cannot
 * rate-limit.
 *
 * A reserve carries the market it belongs to, because the same underlying exists
 * in several Ethereum markets with a different aToken and a different rate in
 * each. Discovery is driven by which aTokens an address actually touched, so
 * adding a market costs requests only for someone who used it.
 */
export function reservesFor(chainId) {
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`Chain ${chainId} not in scope`);

  return chain.markets.flatMap((market) => {
    const book = addressBook[market.book];
    if (!book?.ASSETS) throw new Error(`No ASSETS in address book for ${market.book}`);

    return Object.entries(book.ASSETS)
      .filter(([, asset]) => asset.A_TOKEN && asset.UNDERLYING)
      .map(([symbol, asset]) => ({
        chainId,
        market: market.name,
        symbol,
        decimals: asset.decimals,
        underlying: asset.UNDERLYING.toLowerCase(),
        aToken: asset.A_TOKEN.toLowerCase(),
        vToken: asset.V_TOKEN?.toLowerCase() ?? null,
      }));
  });
}

export const allReserves = () => CHAINS.flatMap((c) => reservesFor(c.id));

/** aToken address -> reserve, for attributing a balance row to a position. */
export function aTokenIndex() {
  const index = new Map();
  for (const reserve of allReserves()) index.set(`${reserve.chainId}:${reserve.aToken}`, reserve);
  return index;
}
