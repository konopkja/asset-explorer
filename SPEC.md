# yield-ledger

**What did my capital actually earn, and what did the wait cost me?**

A local tool that reconstructs your Aave v3 positions and token balances from onchain
history across Ethereum, Base, Optimism and Arbitrum, then reports the number no wallet
or protocol UI shows you: **your** realised annualised return, next to the rate the pool
was actually paying over the same window.

Name is a placeholder. The spine of the design is a dated cashflow ledger, hence the name.

---

## 1. The gap this fills

Aave shows a current balance and a forward-looking APY. MetaMask shows a balance and a
truncated activity feed. Neither answers "I put money in over a year in several chunks,
what rate did I actually get?"

### Prior art, checked 2026-09-11

| Tool | Does | Does not |
|---|---|---|
| [defisim.xyz/interest](https://defisim.xyz/interest) | Aave v3/v4 interest replayed from token events, address input, closed positions included | No personal APR/APY, no XIRR, no pool comparison, no charts, **no Aave v2**, Aave only |
| DeBank / Zerion / Zapper | Balances, USD P&L | No per-position realised rate, no pool-vs-you comparison |
| Koinly / CoinTracker / Rotki / RP2 | Tax lots, cost basis, period P&L | No position-level annualised return, no yield attribution |
| DefiLlama / vaults.fyi / Aavescan | Pool APY, historical rates | The pool's rate, never yours |

**The unclaimed thing is the rate layer.** Interest in token terms is solved. Turning a
cashflow history into a personal annualised return, and putting it beside the pool's own
time-weighted return, is not.

Verified in the defisim source (`hooks/useAaveData.ts`, `pages/api/aave/accrual/index.ts`),
MIT licensed (Vitaly Rtischev, 2022), so its aToken accrual identity is reusable.

### Why defisim can return nothing for a valid v3 position

Unverified for the specific address, but structural and worth designing away from:

- Every scan is a **cold, full-history `eth_getLogs` sweep** from the market's first block,
  executed per request, against a **client-exposed shared Alchemy key**
  (`NEXT_PUBLIC_ALCHEMY_API_KEY`).
- It is bounded at 180s, extended to at most 600s, and fails with the literal message
  `"Interest scan timed out. This address may have too much on-chain history."`
- Old, heavily-used addresses are therefore the designed-for-failure case, and a throttled
  shared key degrades every visitor at once.

**Architectural consequence for us: never sweep full history per pageview.** Read from an
indexed explorer, persist the ledger, and only ever scan forward from a stored high-water
block. Second run is instant; the first is the only slow one.

---

## 2. The one primitive

Everything here is one data structure:

```
Ledger = (chain, asset, positionKind) → [ { block, timestamp, action, delta, txHash } ]
                                        + currentBalance
```

Every feature is a reader over that ledger:

| Feature | Reader |
|---|---|
| Interest earned | `balance − Σ inflow + Σ outflow` |
| Personal APY | XIRR over the dated deltas, terminal value = `balance` |
| Cost basis | weighted average or FIFO over the same deltas |
| Idle drag | gaps between wallet inflow and protocol deposit |
| Every chart | the ledger replayed against a daily price or rate series |

Two event sources fill it, and nothing else:

- **Aave position**: aToken `Mint` / `Burn` / `Transfer`, filtered on the indexed user topic
- **Token holding**: ERC-20 `Transfer` in and out

Two protocols, one ledger, one metrics module, one chart module. Adding Compound or Lido
later means one new event adapter, not a new pipeline.

---

## 3. Data sources — all probed 2026-09-11, all free

| Need | Source | Status |
|---|---|---|
| aToken + ERC-20 events, 4 chains | Blockscout Pro, Etherscan-compat `module=logs&action=getLogs` | Verified on chains 1, 10, 8453, 42161 |
| Whole-portfolio balances | Blockscout REST v2 `/addresses/{a}/token-balances` | One call per chain; returns price + spam signals |
| aToken ↔ underlying map | `@bgd-labs/aave-address-book` v4.44.22 (npm) | Build-time dep, no runtime call |
| Historical daily pool APY | `yields.llama.fi/chart/{poolId}` | 1314 daily points back to 2023-02-06, `apyBase` / `apyReward` / `tvlUsd` split |
| Aave v3 pool discovery | `yields.llama.fi/pools`, `project=aave-v3` | 112 pools on our 4 chains (ETH 68, ARB 17, Base 14, OP 13) |
| Historical + spot prices | `coins.llama.fi/prices/historical/{ts}/{chain}:{addr},...` | Batched multi-chain in one call, returns a `confidence` score |

No paid tier, no archive node, no subgraph key.

> This document is the original design spec, written while the tool still had a keyed CLI
> alongside the browser build. The shipped product is the browser build only: keyless public
> explorer instances, five chains including Linea, no API key anywhere. Where this spec and
> the README disagree, the README describes what exists.

### Gotchas found while probing (each cost a failed call)

- Blockscout's edge returns **403 to a default `urllib` User-Agent**. Send one.
- Blockscout **ignores `page` and `offset`** and clips `getLogs` at **1000 results with no
  truncation signal**. Paginate by resuming `fromBlock` at the last block seen, re-fetching
  that block whole, deduping on `txHash` + `logIndex`.
- Blockscout **pads log `topics` to four entries with nulls**, which ethers' `parseLog`
  rejects. Filter nulls first.
- DefiLlama calls Optimism **`OP Mainnet`**. A filter on `"Optimism"` silently returns zero
  pools, which reads exactly like "Aave isn't deployed there."
- `token-balances` returned **8004 entries** for a well-known mainnet address and 3498 on
  Base. Spam and dust dominate.
- ~~The same response carries `reputation` and `exchange_rate`, which is the filter.~~
  **Corrected during the build:** `reputation` reads `ok` for tokens with a 100-billion
  supply, no price and no market, so it is not a spam filter. What actually separates a
  holding from spam is whether an independent pricing source knows the token at all, then
  a $1 value floor. `reputation` is kept only as a veto for confirmed scams.

---

## 4. Metrics, with the actual formulas

### Interest earned (token-denominated, exact)

aTokens rebase 1:1 with the underlying, so:

```
interest = balance_now − Σ supplied + Σ withdrawn ± Σ aToken transfers
```

Aave's `Mint` and `Burn` events also carry `balanceIncrease`, the interest credited at that
event, which splits **realised** (credited at past events) from **pending** (accrued since
the last touch). This is defisim's identity and it is correct; reuse it.

### Your personal return (money-weighted)

```
XIRR:  solve  Σ CF_i · (1 + r)^(−d_i/365)  =  0
       deposits negative, withdrawals positive, terminal value = balance_now
       Newton–Raphson, bisection fallback on non-convergence
```

This is the headline number. It is the one metric that changes when *you* behave
differently rather than when the pool does.

### What the pool paid (time-weighted, same window)

```
TWR = Π over days d in window (1 + apyBase_d / 365) − 1,   annualised
```

`apyBase` from the DefiLlama chart series, so the comparison is against the pool's real
historical rate rather than today's headline number.

### The gap, decomposed — MVP keeps only what is computable

| Component | Computable now? | Method |
|---|---|---|
| Rate drag | Yes | Pool TWR over your window vs pool TWR over the full period. Did you hold through a bad rate regime? |
| Idle drag | Yes | Days the underlying sat in the wallet undeployed vs deployed, from the same ledger the balance feature already builds |
| Gas drag | Deferred | Blockscout returns tx fees, so it is reachable; it is not worth MVP complexity |
| Reward-token drag | Deferred | Needs claim-event tracking plus price at claim vs price now |

**Explicitly not shipping a generic attribution waterfall.** Every drag number needs a
stated counterfactual printed next to it on screen. An unlabelled decomposition is a
generator of plausible-sounding numbers, which is the one failure mode this project cannot
afford.

---

## 5. Charts — four, each earning its place

Load the `dataviz` skill before writing any chart code. Dark theme, WCAG AA contrast
checked on every pairing.

1. **Position value over time** — area chart of replayed balance, with deposit and
   withdrawal markers. Answers "when did I actually put money in?", which is the thing
   MetaMask has forgotten.
2. **Your APY vs pool APY** — two lines: rolling personal money-weighted return against
   `apyBase`. The money shot. The gap between the lines *is* the product.
3. **Cashflow timeline** — stepped bars of principal in, principal out, interest credited.
   The audit trail behind the headline number, so the number is never unexplained.
4. **Balance by chain** — for the portfolio view only, after spam filtering. Plain, small,
   and honest about what it excluded.

---

## 6. Stack: local-first CLI that emits a self-contained dark HTML report

```
address in  →  fetch (Blockscout + DefiLlama)  →  ledger cache (SQLite or JSON)
            →  metrics  →  one standalone .html with data inlined
```

**Why local rather than hosted, for the MVP:**

- The Blockscout Pro key stays out of client JavaScript. A hosted static page cannot hold it.
- No shared rate limit to exhaust, which is the failure mode we are designing away from.
- Zero hosting cost, genuinely free, nothing to keep alive.
- Matches how the other data tools in `dev/` already work: a script that writes a dark
  standalone HTML file.

**Tradeoff, stated plainly:** it is not a link you can send anyone. If shareability
matters more than the above, Phase 3 below is the upgrade, and it is a small delta because
the compute is already separated from the rendering.

Runtime: Node 25 is installed and `@bgd-labs/aave-address-book` is an npm package, so Node.
Python 3.14 is also available if the address book is vendored as a JSON snapshot instead.

---

## 7. Build phases

**Phase 0 — the ledger and one honest number.** Fetch aToken events for one position on
one chain, build the ledger, print interest + XIRR + pool TWR as plain text. No charts, no
HTML. Ends when the numbers are hand-reconciled against your real Aave position on
Etherscan. *Nothing else gets built until this reconciles.*

**Phase 1 — all reserves, all four chains.** Address-book-driven reserve discovery, the
incremental block-high-water cache, the batched log scan, and the dark HTML report with
charts 1 to 3.

**Phase 2 — the balance inspector.** `token-balances` across all four chains, spam
filtering on `reputation` + `exchange_rate` + a liquidity floor, per-token cost basis from
the transfer ledger, chart 4. This phase also produces the wallet-side transfer history
that Phase 1's idle-drag metric needs, so the two features genuinely share a spine.

**Phase 3, optional — hosted.** Thin serverless proxy holding the key, ledger cache moved
server-side, same renderer. Vercel, since this is a personal project.

Phase 0 is small. Phase 1 is the bulk of the work. Phase 2 is mostly filtering judgment
rather than engineering.

---

## 8. Known limits to state in the UI, not bury

- **Self-transfers between your own wallets look like deposits.** Needs a user-declared
  address set. This is the single largest source of wrong numbers and it must be a visible
  input, not a hidden assumption.
- **Aave v2 is out of scope** for MVP even though nothing else covers it, because the user's
  positions are v3. The event adapter design leaves room for it.
- **Rewards in other tokens** (stkAAVE, incentives) are real yield that MVP does not count.
  Say so on screen next to the APY, or the number is overstated.
- **Pool APY history starts 2023-02-06** in the DefiLlama series. Older windows cannot be
  compared to a pool rate and must render the comparison as unavailable rather than zero.
- **Price confidence**: `coins.llama.fi` returns a confidence score. Anything below a
  threshold renders as a gap in the chart, never as an interpolated line.

---

## 9. Build log — what shipped, and what the build changed

Phases 0 to 2 are built and verified end to end. `README.md` is the operating document
from here; this section records only where reality contradicted the plan above.

**Verified working:** 17 known-answer tests pass, including Microsoft's documented XIRR
example to 1e-6. Both accounting identities close on a real leveraged address
(`balance − netPrincipal == interest`, and `realised + pending == interest`). A real
Ethereum position reconciled to 840.09 USDC of interest, your APY 3.57% against a pool
that paid 3.37% over the same window, in 31 requests and 7 seconds.

**Changed from the plan:**

1. **Discovery-first replaced blind scanning.** 112 reserves times four event filters is
   448 log queries, and Blockscout rejects multi-address log queries outright, so batching
   is not available. One paginated transfer sweep per chain finds every aToken ever touched
   plus its first block, which bounds the event scans. A real address costs ~30 requests.
   The sweep includes zero-address transfers, so closed positions are discoverable — that
   was the correctness risk and it is confirmed, not assumed.
2. **Dating the ledger is free.** Etherscan-compatible `getLogs` returns `timeStamp`, so
   the plan's per-block timestamp lookups are unnecessary. defisim pays one `getBlock` per
   unique block and caps at 2000, showing "—" beyond that; every event here is dated.
3. **The "gap between balance and principal" chart was cut.** Interest is a fraction of a
   percent of principal, so at real scale the two lines sit on top of each other and the
   quantity the chart existed to show is invisible. Replaced by two charts: principal as a
   step line, and cumulative interest on its own axis where it is legible. Rendering it and
   looking at it is what caught this.
4. **Debt tokens had to be handled to get holdings right.** DefiLlama prices Aave debt
   tokens at a *negative* price, so leaving them in a holdings list nets them silently
   against real assets. They are now excluded by address and surfaced as a flagged balance.
5. **The drag decomposition was reduced to what is computable.** Shipped as "capital
   deployed: N of M days", measured from the ledger. Rate drag, gas drag and reward-token
   drag are not shipped, because each needs a counterfactual that would have to be stated
   on screen to be honest.

6. **The sweep cache is what makes the architecture pay off.** Measured on a Base wallet
   with thousands of ERC-20 transfers: 124 requests / 64.8s cold, then 4 requests / 4.2s
   warm with byte-identical output. A truncated sweep keeps its flag across runs rather
   than re-walking a head it already has, because pagination is newest-first and the
   missing history is always deeper than a fresh walk reaches. Backfill from the stored
   cursor is specced but not built.

7. **The browser version turned out to need no key at all**, which reverses the reasoning
   in section 6 above. That section argued for a local CLI because "the Blockscout Pro key
   cannot sit in client JavaScript" — true, but it assumed the Pro host was the only way
   in. The keyless public Blockscout instances serve
   `access-control-allow-origin: *`, including to a `file://` page, so a single HTML file
   can do the entire scan with no key, no server and no secret to protect. Both versions
   now ship: the browser one for "paste an address", the CLI for a saved report and much
   higher rate limits.

   Getting there forced two structural changes. The `ethers` dependency was dropped in
   favour of ~90 lines of zero-dependency log decoding, so the accounting modules run
   unchanged in a browser with no bundler and no CDN. And `scan.js` now takes its
   transport as an injected `client`, so the orchestration is shared rather than
   reimplemented; only the transport differs. The build inlines the shared modules into
   the HTML and asserts that no two of them declare the same top-level name.

   One forced difference: the public instances 429 the etherscan-compatible
   `/api?module=logs` endpoint while serving every `/api/v2/*` endpoint normally. `curl`
   never reproduced it at any request rate; only a real browser request did, which is a
   reminder that testing the transport outside the environment that will use it proves
   nothing. The browser client instead reads the logs of the transactions the sweep
   already named, which works because Aave emits a zero-address `Transfer` alongside every
   `Mint` and `Burn`, so no balance change is missing a transaction.

8. **The first real user bug was an understated balance, not the maths.** A Base USDC
   position reported *negative* interest. The ledger was complete and correct; the
   explorer's indexed aToken balance was 1069.187389 while the contract said 1203.582736.
   Explorers maintain token balances from Transfer events, and aTokens rebase, so accrued
   interest never appears as a transfer and the index falls behind by exactly the amount
   this tool exists to measure. The error scales with how long a position has sat
   untouched, so it was worst on precisely the old, forgotten positions that motivated the
   project.

   Fixed by reading `balanceOf` live over public JSON-RPC (`src/rpc.js`, batched, CORS-open
   on all four chains, shared by both clients). The known-good test address moved from
   840.0902 to 854.9222 USDC of interest, so that earlier "verified" figure had been quietly
   wrong too. Lesson recorded: an identity that closes is not evidence that its *inputs*
   are right, and a derived balance is an input worth distrusting.

9. **Two things the first real address changed.** Its Base USDC position reconciled
   exactly (scaled balance rebuilt from events == `scaledBalanceOf`, difference 0), which
   is now a per-position check shipped in the product rather than a one-off script: every
   card carries a `reconciled` badge or an explicit "incomplete history" warning. On the
   same address an old Optimism WETH dust position came back **not** reconciled, and it is
   labelled as untrustworthy instead of quietly reporting its impossible negative interest.
   That is the intended behaviour.

   Its full scan also used to take minutes and hit Cloudflare 524s. Cause was the
   topic-filtered range scan, which pays for the block range rather than the activity: a
   position opened in 2024 forces a scan over every block since. Reading the sweep's known
   transactions instead, below a 40-transaction threshold, took the whole four-chain scan
   to 59 requests / 14.9s. A tempting alternative — replacing the sweep with per-token
   filtered queries — was measured and is **slower** (15 calls / 13.0s vs 13 calls / 6.8s),
   so it was dropped.

10. **The interest chart was drawing the bookkeeping, not the earnings.** It plotted
    cumulative `balanceIncrease`, which steps only when the position is touched, so a
    227-day gap followed by a 25.40 USDC step read as a random payout. Aave accrues every
    block via the liquidity index; `balanceIncrease` is only a checkpoint whose size
    measures time since the last transaction. Replaced with
    `scaledBalance(t) x index(t) - netPrincipal(t)`, sampled daily, using the index each
    event stamps plus the present one from `balance / scaledBalance`. The curve is smooth,
    monotonic, and its endpoint equals the reported total exactly. Found by the user
    looking at the chart and asking why it was lumpy, which no test would have caught.

**Still true from the plan:** every data source is free and keyless apart from Blockscout,
the accrual identity from defisim is reusable under MIT, and the local-CLI-plus-standalone-
HTML shape keeps the key out of client JavaScript.

## 10. Open questions

1. Which address, and are there several to treat as one entity? Required before Phase 0
   reconciliation.
2. Did defisim fail for you with a timeout, an error, or a silent empty result? This tells
   us whether the timeout theory above is right, which affects nothing in the design but
   confirms the motivation.
3. Borrow side: is debt-side interest in scope, or supply only for MVP? Supply-only is
   assumed throughout this document.
