/**
 * Zero-dependency decoding for the three aToken events.
 *
 * This exists so the accounting code runs unchanged in Node and in a browser
 * with no bundler and no CDN. The alternative was ethers' Interface, which would
 * have to be loaded from a CDN in the browser build; these events are simple
 * enough that decoding them by hand is smaller than the dependency.
 *
 * Topic hashes are keccak256 of the canonical signatures. They were computed
 * with ethers and checked against real mainnet logs before being pinned here.
 */

/** keccak256("Mint(address,address,uint256,uint256,uint256)") */
export const TOPIC_MINT =
  "0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196";
/** keccak256("Burn(address,address,uint256,uint256,uint256)") */
export const TOPIC_BURN =
  "0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90";
/**
 * keccak256("BalanceTransfer(address,address,uint256,uint256)")
 *
 * Aave emits this alongside the ERC-20 Transfer on an aToken transfer between
 * wallets. The plain Transfer carries the amount in underlying units, which is
 * what principal accounting needs; this one carries the SCALED amount and the
 * liquidity index at that moment, which is what a scaled-balance reconciliation
 * needs. Not used by the ledger, used by the completeness check.
 */
export const TOPIC_BALANCE_TRANSFER =
  "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666";
/** keccak256("Transfer(address,address,uint256)") */
export const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const TOPIC = {
  Mint: TOPIC_MINT,
  Burn: TOPIC_BURN,
  Transfer: TOPIC_TRANSFER,
  BalanceTransfer: TOPIC_BALANCE_TRANSFER,
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** An indexed address topic is the address right-aligned in 32 bytes. */
export const topicToAddress = (topic) =>
  `0x${String(topic).replace(/^0x/, "").slice(24)}`.toLowerCase();

/** Left-pad an address into a 32-byte topic, for filtering on an indexed param. */
export const addressToTopic = (address) =>
  `0x${String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

/** The i-th 32-byte word of a data payload, as a BigInt. */
export function word(data, i) {
  const hex = String(data ?? "").replace(/^0x/, "");
  const slice = hex.slice(i * 64, (i + 1) * 64);
  if (slice.length === 0) return 0n;
  return BigInt(`0x${slice}`);
}

/**
 * Decode one log into { name, args } or null when it is not one of our events.
 *
 * Returns lowercase addresses so callers can compare without normalising.
 */
export function decodeLog(log) {
  const topics = (log.topics ?? []).filter((t) => typeof t === "string");
  const sig = (topics[0] ?? "").toLowerCase();

  if (sig === TOPIC_MINT) {
    return {
      name: "Mint",
      args: {
        caller: topicToAddress(topics[1]),
        onBehalfOf: topicToAddress(topics[2]),
        value: word(log.data, 0),
        balanceIncrease: word(log.data, 1),
        index: word(log.data, 2),
      },
    };
  }

  if (sig === TOPIC_BURN) {
    return {
      name: "Burn",
      args: {
        from: topicToAddress(topics[1]),
        target: topicToAddress(topics[2]),
        value: word(log.data, 0),
        balanceIncrease: word(log.data, 1),
        index: word(log.data, 2),
      },
    };
  }

  if (sig === TOPIC_TRANSFER) {
    // Standard ERC-20 puts value in data. A few non-standard tokens index it as
    // a fourth topic; aTokens do not, but reading it either way costs nothing.
    const value = topics.length > 3 ? BigInt(topics[3]) : word(log.data, 0);
    return {
      name: "Transfer",
      args: { from: topicToAddress(topics[1]), to: topicToAddress(topics[2]), value },
    };
  }

  if (sig === TOPIC_BALANCE_TRANSFER) {
    return {
      name: "BalanceTransfer",
      args: {
        from: topicToAddress(topics[1]),
        to: topicToAddress(topics[2]),
        scaledValue: word(log.data, 0),
        index: word(log.data, 1),
      },
    };
  }

  return null;
}
