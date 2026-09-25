import test from "node:test";
import assert from "node:assert/strict";
import { transactionDeltas, lotsForToken, matchFifo, summarise } from "../src/basis.js";

const USER = "0xUSER".toLowerCase();
const MORPHO = "0xmorpho";
const USDC = "0xusdc";
const DAY = 86400;
const T0 = 1700000000;

/** Sweep-shaped transfer row, as src/client-web.js produces them. */
const row = (o) => ({
  token: o.token,
  symbol: o.symbol,
  decimals: o.decimals ?? 18,
  blockNumber: o.block ?? 1,
  timestamp: o.ts,
  from: (o.from ?? "0xother").toLowerCase(),
  to: (o.to ?? "0xother").toLowerCase(),
  raw: o.raw,
  txHash: o.tx,
});

/** One swap: `pay` of USDC leaves, `get` of MORPHO arrives, in one transaction. */
const swap = (tx, ts, pay, get) => [
  row({ tx, ts, token: USDC, symbol: "USDC", decimals: 6, from: USER, raw: BigInt(pay * 1e6) }),
  row({ tx, ts, token: MORPHO, symbol: "MORPHO", to: USER, raw: BigInt(get) * 10n ** 18n }),
];

const close = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `${label}: got ${actual}, expected ~${expected} (tol ${tol})`,
  );

test("a swap is read from the wallet's net position change, with no DEX knowledge", () => {
  const byTx = transactionDeltas(swap("0xa", T0, 30, 15n), USER);
  const { acquisitions, disposals } = lotsForToken(byTx, MORPHO);
  assert.equal(disposals.length, 0);
  assert.equal(acquisitions.length, 1);
  assert.equal(acquisitions[0].qty, 15);
  assert.deepEqual(
    acquisitions[0].paid.map((p) => [p.symbol, p.qty]),
    [["USDC", 30]],
  );
});

test("a transfer to yourself nets to zero and is not a trade", () => {
  const byTx = transactionDeltas(
    [row({ tx: "0xb", ts: T0, token: MORPHO, symbol: "MORPHO", from: USER, to: USER, raw: 5n * 10n ** 18n })],
    USER,
  );
  assert.equal(lotsForToken(byTx, MORPHO).acquisitions.length, 0);
});

test("two buys average correctly and price the gain only against what was paid", () => {
  const byTx = transactionDeltas([...swap("0xa", T0, 30, 15n), ...swap("0xb", T0 + DAY, 20, 10n)], USER);
  const { acquisitions } = lotsForToken(byTx, MORPHO);
  const priced = acquisitions.map((a) => ({ ...a, costUsd: a.paid[0].qty }));
  const { open } = matchFifo(priced, []);
  const s = summarise(open, { balance: 25, priceUsd: 3 });

  assert.equal(s.qtyPriced, 25);
  close(s.costUsd, 50, 1e-9, "total cost");
  close(s.avgCostUsd, 2, 1e-9, "average cost");
  close(s.breakEvenUsd, 2, 1e-9, "break-even");
  close(s.gainUsd, 25, 1e-9, "gain");
  close(s.gainPct, 0.5, 1e-9, "gain pct");
});

test("FIFO consumes the oldest lot first and realises its cost, not the newest", () => {
  const acquisitions = [
    { txHash: "0xa", timestamp: T0, qty: 10, costUsd: 10, paid: [] },
    { txHash: "0xb", timestamp: T0 + DAY, qty: 10, costUsd: 30, paid: [] },
  ];
  const disposals = [{ txHash: "0xc", timestamp: T0 + 2 * DAY, qty: 10, proceedsUsd: 40, received: [] }];
  const { open, realized } = matchFifo(acquisitions, disposals);

  close(realized[0].costUsd, 10, 1e-9, "cost of the first lot");
  close(realized[0].gainUsd, 30, 1e-9, "realised gain");
  assert.equal(open.length, 1);
  assert.equal(open[0].txHash, "0xb");
  close(summarise(open, { balance: 10, priceUsd: 4 }).costUsd, 30, 1e-9, "remaining cost");
});

test("a partial sale splits one lot's cost in proportion", () => {
  const acquisitions = [{ txHash: "0xa", timestamp: T0, qty: 10, costUsd: 100, paid: [] }];
  const disposals = [{ txHash: "0xb", timestamp: T0 + DAY, qty: 4, proceedsUsd: 60, received: [] }];
  const { open, realized } = matchFifo(acquisitions, disposals);

  close(realized[0].costUsd, 40, 1e-9, "40% of the lot");
  close(realized[0].gainUsd, 20, 1e-9, "gain on the sold part");
  close(summarise(open, { balance: 6, priceUsd: 15 }).costUsd, 60, 1e-9, "cost still held");
});

test("an airdrop is quantity with no cost, never a free lot folded into the average", () => {
  const acquisitions = [
    { txHash: "0xa", timestamp: T0, qty: 10, costUsd: 20, paid: [{ symbol: "USDC", qty: 20 }] },
    { txHash: "0xb", timestamp: T0 + DAY, qty: 90, costUsd: null, paid: [] },
  ];
  const { open } = matchFifo(acquisitions, []);
  const s = summarise(open, { balance: 100, priceUsd: 3 });

  assert.equal(s.qtyPriced, 10);
  assert.equal(s.qtyUnpriced, 90);
  close(s.avgCostUsd, 2, 1e-9, "average over the bought part only");
  // The gain is 10 tokens' worth, not 100: the airdrop is not a 100% profit.
  close(s.gainUsd, 10, 1e-9, "gain excludes the airdrop");
  close(s.valueUsd, 300, 1e-9, "value still counts everything held");
});

test("selling more than the history accounts for is flagged, not silently absorbed", () => {
  const acquisitions = [{ txHash: "0xa", timestamp: T0, qty: 5, costUsd: 5, paid: [] }];
  const disposals = [{ txHash: "0xb", timestamp: T0 + DAY, qty: 8, proceedsUsd: 16, received: [] }];
  const { realized } = matchFifo(acquisitions, disposals);
  close(realized[0].unmatchedQty, 3, 1e-9, "unmatched quantity");
});

test("a sale of an unpriced lot realises no gain rather than treating proceeds as pure profit", () => {
  const acquisitions = [{ txHash: "0xa", timestamp: T0, qty: 10, costUsd: null, paid: [] }];
  const disposals = [{ txHash: "0xb", timestamp: T0 + DAY, qty: 10, proceedsUsd: 500, received: [] }];
  const { realized } = matchFifo(acquisitions, disposals);
  assert.equal(realized[0].costUsd, null);
  assert.equal(realized[0].gainUsd, null);
});

test("an ETH-funded buy is priced once the native leg is supplied", () => {
  const transfers = [row({ tx: "0xa", ts: T0, token: MORPHO, symbol: "MORPHO", to: USER, raw: 2n * 10n ** 18n })];
  const byTx = transactionDeltas(transfers, USER);

  const without = lotsForToken(byTx, MORPHO);
  assert.equal(without.acquisitions[0].paid.length, 0, "no counter-leg without native data");

  const withEth = lotsForToken(byTx, MORPHO, {
    nativeDeltas: new Map([["0xa", -(10n ** 18n) / 2n]]),
  });
  assert.deepEqual(
    withEth.acquisitions[0].paid.map((p) => [p.symbol, p.qty]),
    [["ETH", 0.5]],
  );
});

test("undated entries sort last so they cannot corrupt FIFO order", () => {
  const acquisitions = [
    { txHash: "0xundated", timestamp: null, qty: 1, costUsd: 1, paid: [] },
    { txHash: "0xdated", timestamp: T0, qty: 1, costUsd: 2, paid: [] },
  ];
  const byTime = (a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity);
  assert.equal([...acquisitions].sort(byTime)[0].txHash, "0xdated");
});
