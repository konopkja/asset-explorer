/**
 * The five chains in scope. Zero Node dependencies, so this file is inlined
 * verbatim into the built page and also imported by the build itself.
 *
 * `llamaPrice` is the slug coins.llama.fi wants. `llamaYield` is the chain name
 * yields.llama.fi reports, which is NOT the same string for Optimism
 * ("OP Mainnet") and silently matches nothing if guessed.
 *
 * `explorer` is the keyless public Blockscout API host, which serves
 * `access-control-allow-origin: *` and therefore works from a browser with no
 * key and no proxy. The host is pinned per chain because the naming is not
 * uniform: Optimism's public instance is not on the blockscout.com domain at
 * all (optimism.blockscout.com 301s to explorer.optimism.io, and a redirect is
 * not followed on a cross-origin XHR), and Linea splits frontend from API
 * (explorer.linea.build serves only the UI and 404s every /api/v2 path; the API
 * lives on api-explorer.linea.build).
 *
 * `scan` is the human-facing explorer used for transaction links in the report.
 *
 * `markets` are the Aave v3 instances on the chain. Only Ethereum has more than
 * one, and they are genuinely separate markets: the same underlying has a
 * different aToken and a different rate in each, so a position must be compared
 * against its OWN market or the comparison is meaningless.
 *
 *   book           the @bgd-labs/aave-address-book export, which is the source of
 *                  every address.
 *   llamaPoolMeta  the `poolMeta` string DefiLlama stamps on that market's pools,
 *                  with `null` meaning the Core market (DefiLlama leaves poolMeta
 *                  unset there). The key is ABSENT for a market DefiLlama does not
 *                  list at all, which makes the pool comparison render as
 *                  unavailable instead of silently borrowing another market's rate.
 *
 * Verified 2026-09-16 against yields.llama.fi/pools: the address book's
 * `AaveV3EthereumLido` is what DefiLlama calls "Prime Instance" and what Aave's
 * own UI now calls Prime (8 of its 9 reserves matched by symbol); Horizon matched
 * 8 of 9; `AaveV3EthereumEtherFi` has no aave-v3 pools on DefiLlama at all.
 *
 * `logTimestamps: false` marks an instance whose /transactions/{hash}/logs
 * response omits `block_timestamp`. Every time-weighted metric drops undated
 * entries, so those chains take the timestamp from the transfer sweep instead;
 * see src/client-web.js.
 *
 * `rpc` is an official public JSON-RPC endpoint, also `access-control-allow-origin: *`.
 * It is needed because aToken balances MUST be read live: explorers index token
 * balances from Transfer events, and rebasing tokens accrue with no Transfer, so
 * an indexed balance silently drifts below the truth. See src/rpc.js.
 */
export const CHAINS = [
  {
    id: 1,
    name: "Ethereum",
    markets: [
      { name: "Core", book: "AaveV3Ethereum", llamaPoolMeta: null },
      { name: "Prime", book: "AaveV3EthereumLido", llamaPoolMeta: "Prime Instance" },
      { name: "Horizon", book: "AaveV3EthereumHorizon", llamaPoolMeta: "Aave Horizon Market" },
      // Not listed on DefiLlama, so positions here get no pool benchmark.
      { name: "EtherFi", book: "AaveV3EthereumEtherFi" },
    ],
    llamaPrice: "ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    llamaYield: "Ethereum",
    explorer: "https://eth.blockscout.com",
    scan: "https://etherscan.io",
  },
  {
    id: 10,
    name: "Optimism",
    markets: [{ name: "Core", book: "AaveV3Optimism", llamaPoolMeta: null }],
    llamaPrice: "optimism",
    rpc: "https://mainnet.optimism.io",
    llamaYield: "OP Mainnet",
    explorer: "https://explorer.optimism.io",
    scan: "https://optimistic.etherscan.io",
  },
  {
    id: 8453,
    name: "Base",
    markets: [{ name: "Core", book: "AaveV3Base", llamaPoolMeta: null }],
    llamaPrice: "base",
    rpc: "https://mainnet.base.org",
    llamaYield: "Base",
    explorer: "https://base.blockscout.com",
    scan: "https://basescan.org",
  },
  {
    id: 42161,
    name: "Arbitrum",
    markets: [{ name: "Core", book: "AaveV3Arbitrum", llamaPoolMeta: null }],
    llamaPrice: "arbitrum",
    rpc: "https://arb1.arbitrum.io/rpc",
    llamaYield: "Arbitrum",
    explorer: "https://arbitrum.blockscout.com",
    scan: "https://arbiscan.io",
  },
  {
    id: 59144,
    name: "Linea",
    markets: [{ name: "Core", book: "AaveV3Linea", llamaPoolMeta: null }],
    llamaPrice: "linea",
    rpc: "https://rpc.linea.build",
    llamaYield: "Linea",
    explorer: "https://api-explorer.linea.build",
    scan: "https://lineascan.build",
    logTimestamps: false,
  },
];

export const chainById = (id) => CHAINS.find((c) => c.id === id);
