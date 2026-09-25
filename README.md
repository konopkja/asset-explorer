# asset-explorer

**What did your capital actually earn, and what did the pool pay while you held it?**

Reconstructs your Aave v3 supply positions and token balances from onchain history across
Ethereum, Optimism, Base, Arbitrum and Linea — including Ethereum's separate Core, Prime,
Horizon and EtherFi markets — then reports the number no wallet or protocol UI shows: your
own money-weighted annualised return, next to the rate the pool really paid over exactly
your holding window.

The whole thing runs in your browser. No key, no server, no wallet connect, nothing sent
anywhere except the public block explorers and DefiLlama.

## Run it

```bash
npm install && npm run build   # writes web/index.html
open web/index.html            # or double-click it
```

One self-contained HTML file, ~133 KB, 143 Aave v3 reserves across 8 market instances baked
in. Type an address or ENS name, pick chains, scan. It works from `file://` too: the public Blockscout
instances serve `access-control-allow-origin: *`, which allows a null origin.

`web/index.html#vitalik.eth` scans that name on load, so a link is shareable.

```bash
npm run dev    # build, then serve web/ on http://localhost:8931
npm test       # 27 known-answer tests, incl. Microsoft's documented XIRR example
```

## Deploy

Static, so any host works. On Vercel the settings live in `vercel.json`: build with
`node build-web.js`, serve `web/`. No environment variables, because there are no secrets
to hold — every credential-free endpoint is called directly from the visitor's browser.

## What it reports, per position

| Figure | How |
|---|---|
| Interest earned | Exact, in integer base units: `balance − netPrincipal` |
| **Your APY** | XIRR over your real dated deposits, withdrawals and closing balance |
| **Pool APY** | The pool's own daily `apyBase` compounded across your window |
| Difference | The two above, subtracted. This is the point of the tool. |
| **Earning now** | Forward estimate: this balance at the pool's live rate, per month |
| Capital deployed | Days at work vs days elapsed (shown when there is no live balance to forecast) |
| Audit trail | Every event, dated, with principal change and interest credited |
| **Reconciled** | Whether the event set is provably complete (see below) |

Plus wallet holdings per chain, spam-filtered, and any open Aave debt (flagged, not
accounted for).

### Positions you have since exited

The transfer sweep sees an aToken that was *ever* touched, so closed positions come back
from the same scan with no extra request. They get one line each in a **Previously held**
strip under the open cards — chain, asset, interest earned in token terms, opened, closed —
rather than a card, because dust dominates them: a 2 OP position held for an afternoon
otherwise reads exactly like a real one.

The strip is thresholded at **$10 of peak principal**, valued at **today's** price. That is
an approximation, and it is the honest one available without a historical price call per
position: an asset that has since appreciated can cross the line on value it never had, and
one that has fallen can miss it. The count of positions below the line is always printed, so
nothing is silently dropped. A row whose events do not reconcile against the contract is
marked `!`, because its earned amount is then unreliable.

A withdrawal that empties a position routinely leaves a few wei of aToken behind (29 wei of
aUSDC, on the position that prompted this), which is a non-zero balance and so reads as open
while displaying a balance of 0. Anything worth **under a cent** therefore counts as exited
and lands in the strip. `isOpen` in the payload stays a fact about the chain; the dust
judgement is a separate `isDust` flag.

## What you paid for what you hold

The scan already sweeps every ERC-20 transfer the wallet ever made, and that is
enough to reconstruct cost basis with **no extra explorer requests at all**. A swap,
whoever routed it, is one transaction in which your balance of one token falls and
another rises, so the trade is read from your net position change per transaction:
whatever left the wallet is what you paid. No DEX adapters, no router allow-list —
it works the same for Uniswap, CoW, an aggregator or a contract nobody has decoded.

Each priced holding gets a cost, a break-even price and a profit or loss, plus an
expandable history of every buy and sale with the other side of each trade named.

- **ETH legs** are not ERC-20 transfers, so they come from two extra paginated
  address endpoints per chain (`transactions?filter=from` and
  `internal-transactions`). Paginated per address, never per transaction: a probe
  that fetched ~100 single transactions took a 429 from the public instance and
  stayed limited for minutes, while the paged sweep of the same history is a
  handful of calls.
- **Prices** come from one `batchHistorical` call for every leg of every trade
  across all chains at once, rather than one call per trade date.
- **Tokens that arrived with nothing on the other side** — an airdrop, a claim, an
  exchange withdrawal, your own second wallet — have no onchain cost. They are
  counted as quantity with an UNKNOWN basis, never as free profit, because the
  chain cannot tell a genuine airdrop from something you bought elsewhere. Selling
  one realises no stated gain rather than booking the whole proceeds.
- **FIFO**, oldest lot first, so every remaining lot stays traceable to the
  transaction that created it.
- **Gas is not included**, so a break-even price is slightly optimistic.
- **A token you traded is listed whatever it is worth now**, overriding the $1
  dust floor that buries airdropped spam, because 4.33 USDC of a token now worth
  one cent is a 99.8% loss and that is the answer the holder wants. A token bought
  and then sold to zero has no balance row at all, so it is added back from the
  sweep with its realised result. Two filters keep that from turning into noise:
  the unit of account is dropped (every swap has USDC on one side, which would
  otherwise read as a token bought 12 times and sold 20 times — detected from the
  price sitting within 1% of a dollar, not from a hardcoded list, so a depegged
  stable still shows), and so is any token whose whole trading history is worth
  under a dollar.

## How it works

One primitive, read many ways: a dated cashflow ledger per position.

```
discover      one paginated transfer sweep per chain  ->  which aTokens were ever
              touched (closed positions included), from which block, in which txs

events        per touched aToken, the logs of the transactions the sweep named

reduce        ledger -> interest, XIRR, utilisation, exact balance history
compare       DefiLlama apyBase history -> what the pool paid over your window
render        one renderer -> the live page, or a standalone dark HTML file
```

```
src/
  chains.js      5 chains: explorer APIs, market instances, DefiLlama's names
  basis.js       trades from net position change, FIFO lots, cost basis
  decode.js      zero-dep aToken event decoding, pinned topic hashes
  ledger.js      events -> classified, dated principal/interest ledger
  metrics.js     XIRR, pool TWR, utilisation, exact balance series
  llama.js       pool index, rate history, prices
  rpc.js         live balanceOf / scaledBalanceOf / liquidity index reads
  scan.js        orchestration over an injected transport client
  client-web.js  keyless public explorer instances, sessionStorage, baked reserves
  reserves.js    build-time reserve table from @bgd-labs/aave-address-book
  report.js      CSS + renderer + standalone-file composer
build-web.js     inlines the shared modules into one HTML file
```

Scanning all 143 reserves blind would cost hundreds of log queries. Discovery-first turns a
real address into roughly 30 requests, and adding a market costs requests only for someone
who actually used it.

### Why the events come per transaction, not per range

A topic-filtered `getLogs` pays for the block range it covers, not the activity in it, so a
position opened two years ago forces a scan across every block since, however few times it
was touched — and the public instances **rate-limit the etherscan-compatible
`/api?module=logs` endpoint hard** while serving every `/api/v2/*` endpoint happily.

Aave emits a zero-address `Transfer` alongside every `Mint` and `Burn`, so the sweep already
names every transaction that changed a position. Reading those transactions' logs yields
the identical event set at one request per transaction, which is proportional to real
activity rather than to chain history.

### Caching and truncation

The discovery sweep is the only expensive part, and transfers are immutable once mined, so
sweeps are cached in `sessionStorage` and re-scans read pages only until they reach a block
already held.

A sweep that hit the 60-page budget stays flagged `truncated` and keeps the flag across
runs. Pagination runs newest-first, so the missing history is always deeper than a fresh
walk would reach. **Backfill is not implemented**, so a wallet with more than ~3000 ERC-20
transfers on one chain may be missing its oldest positions, and the report says so rather
than implying the scan was complete.

### Why not per-token discovery

Tempting alternative: instead of sweeping every ERC-20 transfer, query
`token-transfers?token=<aToken>` once per reserve. Measured on a real address on Base, that
is **slower** — 15 calls / 13.0s against 13 calls / 6.8s for the sweep — because the sweep
pages 50 transfers at a time while per-token discovery pays a round trip per reserve
regardless of whether the user ever touched it. It only wins on wallets whose spam history
is deep enough to blow the page budget. Left alone.

### Why not a live RPC sweep

The closest prior art, [defisim.xyz/interest](https://defisim.xyz/interest) (MIT, and the
source of the accrual identity used here), runs a cold full-history `eth_getLogs` sweep per
request against a client-exposed shared Alchemy key, bounded at 180s and failing with
*"This address may have too much on-chain history."* Old, busy addresses are the
designed-for-failure case. Reading from an indexed explorer with a block-bounded scan
removes that failure mode.

## Proving the event set is complete

The balance identity closing proves nothing on its own: both sides are built from the same
events, so a missing deposit cancels out. The real check uses a quantity that interest
cannot touch.

Aave stores a **scaled** balance: your balance divided by the liquidity index at the time
of each movement. Interest accrues by the index rising, so the scaled balance changes
**only when principal moves**. Rebuilding it from the events found here and comparing with
the contract's own `scaledBalanceOf` therefore answers exactly the question the identity
cannot:

```
reconstructed = SUM over events of principalDelta.rayDiv(index_at_that_event)
match with scaledBalanceOf()  =>  no deposit or withdrawal was missed
```

Every position is checked this way on every scan and carries a `reconciled` badge when it
matches. A mismatch is reported on the card as incomplete history rather than quietly
producing a plausible wrong number.

One wrinkle: a plain aToken transfer between wallets emits an ERC-20 `Transfer` carrying
underlying units with **no index on it**. Aave emits a separate `BalanceTransfer` in the
same transaction with the scaled amount and the index, and that is what closes the
reconciliation for transfers. Measured on a real position, ignoring it left a 0.0658% gap
that looked exactly like a missing event.

## Correctness notes

- **`Mint` is not always a deposit.** A withdrawal smaller than accrued interest emits a
  `Mint` with `value = balanceIncrease − amountWithdrawn`, so its principal flow is
  negative. Identity verified against defisim's implementation and covered by a test.
- Interest accounting is BigInt end to end. Floats appear only in rate math and display.
- Ray rounding can make a genuinely zero-yield position compute a few wei negative. Dust
  within `eventCount + 1` wei is clamped; anything larger is surfaced as a data problem on
  the card rather than hidden.
- **The monthly estimate is forward-looking and uses the pool's live rate**, not your
  historical XIRR: your past timing says nothing about what next month pays. It is
  `balance × ((1 + apyBase)^(1/12) − 1)` — the twelfth root, not a twelfth, because
  `apyBase` already compounds. Suppressed on dust, where it would forecast `0.0000/mo`.
- **Interest accrues continuously and is charted that way.** Aave credits nothing when you
  transact: your balance is `scaledBalance × liquidityIndex` and the index rises every
  block. The `balanceIncrease` stamped on each event is only a checkpoint of what accrued
  since you last touched the position, so charting *those* draws lumps whose size is really
  the gap between your transactions. The curve plots
  `scaledBalance(t) × index(t) − netPrincipal(t)` instead, with the index known exactly at
  every event and at now, interpolated geometrically between.
- Balance history is **exact at every event** (each event updates the interest index) and
  drawn as steps, because a straight line across a gap between events shows a rise that did
  not happen.

## Gotchas found while building this (each one cost a wrong result)

| Thing | Reality |
|---|---|
| Blockscout 403 | Its edge rejects Node's default fetch UA. Send a `User-Agent`. |
| Blockscout log paging | Ignores `page`/`offset`, clips at 1000 rows, gives no truncation signal. Resume from the last block seen and dedupe. |
| Blockscout topics | Padded to four entries with nulls; ethers' `parseLog` rejects them. |
| Blockscout multi-address | `address=a,b` is rejected outright. One contract per query. |
| Public vs Pro endpoints | The public instances serve every `/api/v2/*` endpoint but 429 the etherscan-compatible `/api?module=logs`. `curl` never reproduced it; only a real browser request did. |
| Optimism's public explorer | `optimism.blockscout.com` 301s to `explorer.optimism.io`, and a cross-origin XHR does not follow redirects. Pin the final host. |
| **Linea's explorer host** | `explorer.linea.build` serves the UI only and 404s every `/api/v2` path; `linea.blockscout.com` does not exist. The API is on **`api-explorer.linea.build`** (CORS `*`). The Blockscout Pro multichain host answers `{"error":"Network not supported"}` for chain 59144 even with a key. |
| **Missing `block_timestamp`** | Linea's Blockscout release omits `block_timestamp` from `/transactions/{hash}/logs` (Base's includes it). Every time-weighted metric drops undated entries, so the whole chain would have reported no APY **silently**. The sweep already dates every transaction whose logs get fetched, so the fallback costs no request. |
| `file://` fetch | Works against these APIs: the null origin is allowed by `access-control-allow-origin: *`. Inline ES modules are fine; `import` between them is not. |
| Blockscout v2 address logs | `/api/v2/addresses/{a}/logs` exists but cannot filter by topic (`?topic0=` → 422), so it cannot stand in for a user-filtered query. |
| ENS via search | `/api/v2/search` matches token names too, in the same list. Filter `type === "ens_domain"` and prefer an exact name, or `usdc.eth` resolves to a token contract. |
| **Indexed token balances** | **Explorers derive balances from Transfer events. aTokens rebase, so interest lands with NO Transfer and the indexed balance silently runs below the truth.** Measured on a real Base position: explorer 1069.187389 aUSDC vs chain 1203.582736, against 1141.105387 net principal, i.e. a reported 71.92 loss instead of a 62.48 gain. Balances that feed the maths are read live via `eth_call`. |
| Blockscout `/api/eth-rpc` | Public instances 429 it quickly. The official chain RPCs answer with `access-control-allow-origin: *`, so they work from the browser too. |
| `reputation` field | Says `ok` for a token with 100bn supply, no price and no market. **Not a spam filter.** The price floor does that work. |
| Aave debt tokens | DefiLlama prices them at a **negative** price (`-0.9997`). Left in a holdings list they net silently against real assets. |
| DefiLlama chain name | Optimism is `OP Mainnet`. Filtering on `"Optimism"` returns zero pools, which reads as "not deployed". Linea is plain `Linea`. |
| One underlying, many pools | Ethereum USDC exists in Core, Prime, Horizon and Umbrella with different rates *and* different aTokens — 3.56%, 3.19% and 5.69% base on the same day. So the pool index is keyed on (chain, underlying, **market**); keying on the underlying alone silently benchmarks a position against whichever market was written last. DefiLlama's `poolMeta` is `null` for Core, `"Prime Instance"` for the address book's `AaveV3EthereumLido`, `"Aave Horizon Market"` for Horizon, and absent entirely for EtherFi, which therefore gets no benchmark rather than a borrowed one. |
| SVG `preserveAspectRatio="none"` | Stretches the viewBox and distorts text. Measure the container and draw at its width. |

## Verified

- 27 known-answer tests, including Microsoft's documented XIRR example to 1e-6, and
  FIFO cases covering partial sales, airdrops, ETH-funded buys and selling more than
  the history accounts for.
- Both accounting identities close on a real leveraged mainnet address:
  `balance − netPrincipal == interest`, and `realised + pending == interest`.
- Linea, scanned in a browser against a real address: 2 positions, both reconciled, dated
  and charted — USDC over 226 days at your 4.09% against a pool paying 3.86%, WETH over 344
  days at 1.82% against 1.57%, in 25 requests / 12s.
- Market routing, on a real Horizon position: the card benchmarks it at the pool's 5.69%,
  which is Horizon USDC's `apyBase`, not Core's 3.56% or Prime's 3.19% on the same day. The
  Prime and EtherFi mappings are matched by reserve symbol against DefiLlama, not yet by a
  live position.
- ENS resolves in the browser (`vitalik.eth`, `nick.eth`, a raw address, and a nonexistent
  name, which errors clearly rather than resolving to a token).
- Rendered and inspected at 1280px and 400px: no horizontal overflow, tables in their own
  scroll containers, chart text undistorted.
- Chart palette passes the dataviz validator on all pairs in dark mode.

## Scope

Supply side only, across the markets compiled into the page: Core, Prime, Horizon and
EtherFi on Ethereum, Core alone on the other four chains. Not included: borrow-side
interest, Aave v2, DefiLlama's "Umbrella" and "Legacy" pools (neither is a market positions
are read from), reward tokens, gas, and transfers between wallets you both control (those
look like deposits and will skew your APY). Pool rate
history begins 2023-02-06; earlier windows render the comparison as unavailable rather than
guessing. Linea's `wrsETH` reserve has no DefiLlama pool, so a position in it gets no pool
benchmark. Each limit is restated in the report footer.

See `SPEC.md` for the design rationale and prior-art survey.

MIT licensed.
