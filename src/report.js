/**
 * Report presentation, in three exported pieces so the static CLI output and the
 * interactive browser build share one renderer rather than drifting apart:
 *
 *   REPORT_CSS      the whole stylesheet
 *   RENDER_SCRIPT   browser source defining window.YieldLedger.render(data, hosts)
 *   renderReport()  composes both plus an inlined payload into a standalone file
 *
 * RENDER_SCRIPT is a string because it is never executed in Node, only embedded.
 */

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * Series colours are categorical slots 1-3 stepped for a dark surface, validated
 * against #14141c with the dataviz palette validator: all-pairs CVD dE 9.4,
 * normal-vision dE 20.9, all three at or above 3:1 contrast on the surface.
 */
export const REPORT_CSS = `
  :root {
    color-scheme: dark;
    --surface-0: #0d0d13;
    --surface-1: #14141c;
    --surface-2: #1c1c26;
    --line: #2b2b38;
    --text-1: #f4f4f7;
    --text-2: #a8a8b8;
    --text-3: #74748a;
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --good: #199e70;
    --bad: #e66767;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding-block: 40px;
    padding-inline: 24px;
    background: var(--surface-0);
    color: var(--text-1);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 6px; }
  h2 { font-size: 1.05rem; font-weight: 600; margin: 44px 0 14px; }
  h3 { font-size: 0.95rem; font-weight: 600; margin: 0; }
  a { color: var(--series-1); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .sub { color: var(--text-2); font-size: 0.875rem; margin: 0; }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  .card {
    background: var(--surface-1);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 18px;
  }
  .card-head {
    display: flex; flex-wrap: wrap; gap: 10px;
    align-items: baseline; justify-content: space-between;
    margin-bottom: 18px;
  }
  .badge {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 3px 8px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line);
  }
  .badge.open { color: var(--good); }
  .badge.verified { color: var(--series-1); cursor: help; }

  .hero { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-end; margin-bottom: 22px; }
  .hero-fig { font-size: 2.5rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.05; }
  .hero-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-3); margin-bottom: 2px; }
  .hero-mid { font-size: 1.5rem; font-weight: 600; color: var(--text-2); }
  .gap-good { color: var(--good); }
  .gap-bad { color: var(--bad); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 4px; }
  .stat { background: var(--surface-2); border-radius: 9px; padding: 12px 14px; min-width: 0; }
  .stat .k { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); }
  .stat .s { font-size: 0.72rem; color: var(--text-3); margin-top: 2px; line-height: 1.35; }
  .stat .v { font-size: 1.05rem; font-weight: 600; font-family: var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

  .chart { margin-top: 24px; }
  .chart-title { font-size: 0.8rem; font-weight: 600; color: var(--text-2); margin-bottom: 2px; }
  .chart-note { font-size: 0.75rem; color: var(--text-3); margin-bottom: 10px; }
  .plot { position: relative; width: 100%; }
  .plot svg { display: block; width: 100%; height: auto; overflow: visible; }
  .tip {
    position: absolute; pointer-events: none; opacity: 0;
    transform: translate(-50%, -100%);
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 7px; padding: 7px 10px; font-size: 0.75rem;
    font-family: var(--mono); white-space: nowrap; z-index: 5;
    transition: opacity 90ms linear;
  }

  details { margin-top: 20px; }
  summary {
    cursor: pointer; font-size: 0.8rem; color: var(--text-2);
    padding: 8px 0; list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "\\25b8 "; color: var(--text-3); }
  details[open] summary::before { content: "\\25be "; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--text-3); font-weight: 500; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--text-2); }
  td.name { font-family: var(--sans); color: var(--text-1); }
  .pos { color: var(--good); }
  .neg { color: var(--bad); }

  .warn {
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 9px; padding: 14px 16px; margin-bottom: 18px;
    font-size: 0.85rem; color: var(--text-2);
  }
  .warn strong { color: var(--text-1); }
  footer { margin-top: 52px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 0.82rem; color: var(--text-3); }
  footer h2 { margin-top: 0; color: var(--text-2); }
  footer li { margin-bottom: 7px; }
  .empty { color: var(--text-2); padding: 26px 0; }
  @media (max-width: 560px) {
    body { padding-inline: 16px; }
    .hero-fig { font-size: 2rem; }
  }
`;

export const METHODOLOGY_HTML = `
    <h2>How these numbers are produced</h2>
    <ul>
      <li><strong>Interest</strong> is exact, not estimated. Every Aave balance change emits an event, so lifetime interest = current balance &minus; net principal, where net principal nets out the interest Aave bakes into each <code>Mint</code> and <code>Burn</code> value. Computed in integer base units throughout.</li>
      <li><strong>Your APY</strong> is XIRR: the single annual rate that discounts your real dated deposits and withdrawals, plus today's balance, back to zero. It changes when you act differently, which is what makes it yours rather than the pool's.</li>
      <li><strong>Pool APY</strong> is the pool's own daily <code>apyBase</code> history compounded across exactly your holding window, so the comparison is against what the pool really paid rather than what it advertises today.</li>
      <li><strong>Every position is reconciled against the contract.</strong> Aave stores a <em>scaled</em> balance that moves only when principal moves, never when interest accrues. Rebuilding that scaled balance from the events found here and comparing it with the contract's own <code>scaledBalanceOf</code> proves whether any deposit or withdrawal was missed. A position marked <em>reconciled</em> matched exactly.</li>
      <li><strong>Balances are read live</strong> via <code>balanceOf</code>, never from an explorer's index: aTokens accrue with no transfer event, so an indexed balance runs below the truth and would understate your interest.</li>
      <li><strong>Interest accrues continuously, and is drawn that way.</strong> Aave credits nothing when you transact: your balance is <code>scaledBalance &times; liquidityIndex</code> and the index rises every block. The <code>balanceIncrease</code> stamped on each event is only a checkpoint of what accrued since you last touched the position, so charting those would show lumps whose size is really just the gap between your transactions. The curve instead plots <code>scaledBalance(t) &times; index(t) &minus; netPrincipal(t)</code>, with the index known exactly at every event and at now, interpolated geometrically between.</li>
      <li><strong>Balance history</strong> is exact at every event, because each event updates your interest index. Both lines are drawn as steps: a straight line across a gap between events would show a rise that did not happen.</li>
    </ul>
    <h2>What these numbers deliberately do not include</h2>
    <ul>
      <li><strong>Transfers between your own wallets look like deposits.</strong> If you moved funds between addresses you control, your APY here is wrong. Only one address was scanned.</li>
      <li><strong>Reward tokens are not counted.</strong> Incentives paid in a different token are real yield that this report omits, so a position earning them is understated.</li>
      <li><strong>Gas is not counted.</strong> Your net return after fees is lower than shown.</li>
      <li><strong>Borrow-side interest is out of scope.</strong> Supply positions only.</li>
      <li><strong>Pool rate history begins 2023-02-06.</strong> An older window shows the comparison as unavailable rather than guessing.</li>
      <li><strong>Aave v2 is not included</strong>, and neither is any market outside the set compiled into this page. On Ethereum that set is Core, Prime, Horizon and EtherFi; every other chain has Core only. Each market is compared against its own pool rate, never another market's, and a market DefiLlama does not publish rates for shows the comparison as unavailable.</li>
    </ul>
`;

export const RENDER_SCRIPT = String.raw`
(function () {
  const S1 = "var(--series-1)", S2 = "var(--series-2)", S3 = "var(--series-3)";

  const num = (v, d) => {
    if (v == null || !isFinite(v)) return "—";
    const digits = d === undefined ? 4 : d;
    // Without this a value of -2.7e-7 formats as "-0" on an axis label.
    const shown = Math.abs(v) < 0.5 * Math.pow(10, -digits) ? 0 : v;
    return shown.toLocaleString("en-US", { maximumFractionDigits: digits });
  };
  const usd = (v) => v == null || !isFinite(v) ? "—"
    : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const pctS = (v, d) => {
    if (v == null || !isFinite(v)) return "—";
    const digits = d === undefined ? 2 : d;
    const p = v * 100;
    // Anything that rounds to zero must print "0.00%", never "-0.00%".
    const r = Math.abs(p) < 0.5 * Math.pow(10, -digits) ? 0 : p;
    return r.toFixed(digits) + "%";
  };
  const day = (ts) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—";
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  /**
   * "Open" for display means money still at work. A position emptied by a
   * withdrawal keeps a few wei of aToken dust, which is a real non-zero balance
   * on the chain and would otherwise get a full card reading a balance of 0.
   */
  const isLive = (p) => p.isOpen && !p.isDust;

  // Ethereum has several Aave markets. Naming the market matters only when it is
  // not the Core one, which is what an unqualified "Ethereum USDC" means.
  const label = (p) => p.chainName + " &middot; " +
    (p.market && p.market !== "Core" ? p.market + " &middot; " : "") + p.symbol;

  const SCAN = { 1: "https://etherscan.io", 10: "https://optimistic.etherscan.io",
    8453: "https://basescan.org", 42161: "https://arbiscan.io",
    59144: "https://lineascan.build" };
  const txUrl = (chainId, hash) => (SCAN[chainId] || SCAN[1]) + "/tx/" + hash;

  /**
   * Multi-series step/line plot with a crosshair tooltip.
   *
   * Drawn at the container's measured width rather than into a fixed viewBox
   * stretched to fit: a stretched viewBox scales text non-uniformly, which made
   * these unreadable at phone width.
   */
  function linePlot(host, opts) {
    const draw = () => {
      host.innerHTML = "";
      drawPlot(host, opts, Math.max(320, Math.round(host.clientWidth || 760)));
    };
    draw();
    if (typeof ResizeObserver === "function") {
      let last = host.clientWidth;
      new ResizeObserver(() => {
        if (Math.abs(host.clientWidth - last) > 12) { last = host.clientWidth; draw(); }
      }).observe(host);
    }
  }

  function drawPlot(host, opts, W) {
    const { series, yFormat, xDomain, rules = [], height = 210 } = opts;
    const H = height;
    // Narrow viewports get a tighter left gutter, or axis labels eat the plot.
    const m = { t: 12, r: 14, b: 26, l: W < 460 ? 46 : 62 };
    const pts = series.flatMap(s => s.points);
    if (pts.length < 2) { host.appendChild(el("p", "chart-note", "Not enough data to plot.")); return; }

    const x0 = xDomain ? xDomain[0] : Math.min.apply(null, pts.map(p => p.x));
    const x1 = xDomain ? xDomain[1] : Math.max.apply(null, pts.map(p => p.x));
    let y0 = Math.min.apply(null, [0].concat(pts.map(p => p.y), rules.map(r => r.y)));
    let y1 = Math.max.apply(null, pts.map(p => p.y).concat(rules.map(r => r.y)));
    if (y1 === y0) y1 = y0 + 1;
    y1 += (y1 - y0) * 0.08;

    const sx = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const sy = (v) => H - m.b - ((v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    const add = (tag, attrs) => {
      const n = document.createElementNS(ns, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
      return n;
    };

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = y0 + ((y1 - y0) * i) / ticks;
      add("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), stroke: "var(--line)", "stroke-width": 1 });
      const t = add("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end", fill: "var(--text-3)", "font-size": 11 });
      t.textContent = yFormat(v);
    }
    [x0, x1].forEach((v, i) => {
      const t = add("text", { x: i ? W - m.r : m.l, y: H - 8, "text-anchor": i ? "end" : "start", fill: "var(--text-3)", "font-size": 11 });
      t.textContent = day(v);
    });

    // Your rate and the pool's are usually within a fraction of a percent, which
    // puts their labels on top of each other. Highest line first, each colliding
    // label nudged DOWN so labels stay in the same order as the lines they name.
    const LABEL_H = 13;
    let lastLabelY = -Infinity;
    rules.slice().sort((a, b) => sy(a.y) - sy(b.y)).forEach(r => {
      add("line", { x1: m.l, x2: W - m.r, y1: sy(r.y), y2: sy(r.y), stroke: r.color, "stroke-width": 1.5, "stroke-dasharray": "5 4", opacity: 0.85 });
      let ly = Math.max(sy(r.y) - 6, 10);
      if (ly - lastLabelY < LABEL_H) ly = lastLabelY + LABEL_H;
      lastLabelY = ly;
      const t = add("text", { x: W - m.r, y: ly, "text-anchor": "end", fill: r.color, "font-size": 11, "font-weight": 600 });
      t.textContent = r.label;
    });

    series.forEach(s => {
      const d = s.points.map((p, i) => {
        if (i === 0) return "M " + sx(p.x) + " " + sy(p.y);
        const prev = s.points[i - 1];
        return s.step
          ? "L " + sx(p.x) + " " + sy(prev.y) + " L " + sx(p.x) + " " + sy(p.y)
          : "L " + sx(p.x) + " " + sy(p.y);
      }).join(" ");
      add("path", { d: d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
      (s.markers || []).forEach(p => {
        add("circle", { cx: sx(p.x), cy: sy(p.y), r: 4.5, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2 });
      });
    });

    const cross = add("line", { x1: 0, x2: 0, y1: m.t, y2: H - m.b, stroke: "var(--text-3)", "stroke-width": 1, opacity: 0 });
    host.appendChild(svg);
    const tip = el("div", "tip");
    host.appendChild(tip);

    const primary = series[0].points;
    svg.addEventListener("pointermove", (ev) => {
      const box = svg.getBoundingClientRect();
      const vx = ((ev.clientX - box.left) / box.width) * W;
      const xv = x0 + ((vx - m.l) / (W - m.l - m.r)) * (x1 - x0);
      let best = primary[0];
      for (const p of primary) if (Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
      cross.setAttribute("x1", sx(best.x));
      cross.setAttribute("x2", sx(best.x));
      cross.setAttribute("opacity", 0.5);
      const rows = series.map(s => {
        let q = s.points[0];
        for (const p of s.points) if (Math.abs(p.x - best.x) < Math.abs(q.x - best.x)) q = p;
        return "<div>" + s.name + ": " + yFormat(q.y) + "</div>";
      }).join("");
      tip.innerHTML = "<div>" + day(best.x) + "</div>" + rows + (best.label ? "<div>" + best.label + "</div>" : "");
      tip.style.left = (sx(best.x) / W) * box.width + "px";
      tip.style.top = Math.max(sy(best.y) / H * box.height - 10, 0) + "px";
      tip.style.opacity = 1;
    });
    svg.addEventListener("pointerleave", () => {
      tip.style.opacity = 0;
      cross.setAttribute("opacity", 0);
    });
  }

  function positionCard(p) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.appendChild(el("div", null, "<h3>" + label(p) + "</h3>"));
    const badges = el("div", null);
    badges.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    if (p.eventsComplete === true) {
      const v = el("span", "badge verified", "reconciled");
      v.title = "The scaled balance rebuilt from this position's events matches the contract exactly, "
        + "so no deposit or withdrawal is missing.";
      badges.appendChild(v);
    }
    badges.appendChild(el("span", "badge" + (isLive(p) ? " open" : ""), isLive(p) ? "open" : "closed"));
    head.appendChild(badges);
    card.appendChild(head);

    if (p.balanceIsLive === false) {
      card.appendChild(el("div", "warn",
        "<strong>Balance not read live.</strong> The chain could not be reached, so this uses the " +
        "explorer's indexed balance. aTokens accrue interest without emitting a transfer, so an " +
        "indexed balance runs below the real one and the interest here is understated."));
    }
    if (p.eventsComplete === false) {
      card.appendChild(el("div", "warn",
        "<strong>Incomplete history.</strong> Rebuilding this position's scaled balance from its " +
        "events gives " + num(p.scaledDrift) + " " + p.symbol + " more than the contract reports, " +
        "which means at least one deposit or withdrawal is missing from the scan. Every figure " +
        "on this card is therefore wrong."));
    }
    if (p.interestIsNegative) {
      card.appendChild(el("div", "warn",
        "<strong>Negative interest, which cannot really happen.</strong> An Aave supply balance only " +
        "grows, so this means the scan missed some of your deposits or withdrawals and net principal " +
        "came out too high. Treat every figure on this card as unreliable."));
    }

    const gap = (p.myApy != null && p.poolApy != null) ? p.myApy - p.poolApy : null;
    const hero = el("div", "hero");
    hero.appendChild(el("div", null,
      '<div class="hero-label">Your APY</div><div class="hero-fig mono">' + pctS(p.myApy) + "</div>"));
    hero.appendChild(el("div", null,
      '<div class="hero-label">Pool paid</div><div class="hero-mid mono">' + pctS(p.poolApy) + "</div>"));
    if (gap != null) {
      // A gap that rounds to zero is neither good nor bad, so it gets no colour
      // and no sign rather than reading as a tiny loss.
      const flat = Math.abs(gap) < 0.00005;
      hero.appendChild(el("div", null,
        '<div class="hero-label">Difference</div><div class="hero-mid mono ' +
        (flat ? "" : gap > 0 ? "gap-good" : "gap-bad") + '">' +
        (flat ? "" : gap > 0 ? "+" : "") + pctS(gap) + "</div>"));
    }
    card.appendChild(hero);

    const util = p.utilisation.days > 0
      ? Math.round((p.utilisation.deployedDays / p.utilisation.days) * 100) : 0;
    const stats = el("div", "stats");
    [
      ["Interest earned", num(p.interest) + " " + p.symbol, usd(p.interestUsd)],
      ["Balance now", num(p.balance) + " " + p.symbol, usd(p.balanceUsd)],
      ["Net principal", num(p.netPrincipal) + " " + p.symbol, ""],
      ["Avg principal at work", num(p.utilisation.averagePrincipal, 2) + " " + p.symbol, ""],
      ["Held since", day(p.firstTs), Math.round(p.utilisation.days) + " days, " + p.eventCount + " events"],
      p.monthlyEstimate != null
        ? ["Earning now", "~" + num(p.monthlyEstimate, p.monthlyEstimate < 10 ? 4 : 2) + " " + p.symbol + "/mo",
           (p.monthlyEstimateUsd != null ? usd(p.monthlyEstimateUsd) + "/mo &middot; " : "") +
           "at the pool's " + (p.poolApyNow != null ? p.poolApyNow.toFixed(2) + "%" : "current") + " APY"]
        : ["Capital deployed", util + "% of the time", Math.round(p.utilisation.deployedDays) + " of " + Math.round(p.utilisation.days) + " days"],
    ].forEach(function (row) {
      stats.appendChild(el("div", "stat",
        '<div class="k">' + row[0] + '</div><div class="v">' + row[1] + "</div>" +
        (row[2] ? '<div class="s">' + row[2] + "</div>" : "")));
    });
    card.appendChild(stats);

    // Two charts rather than one. Balance and principal were originally drawn
    // together so the gap between them would read as the interest, but interest
    // is a fraction of a percent of principal, so the lines sat on top of each
    // other and the quantity the chart existed to show was invisible.
    if (p.series && p.series.length > 1) {
      const c = el("div", "chart");
      c.appendChild(el("div", "chart-title", "Principal you had in this pool"));
      c.appendChild(el("div", "chart-note", "Steps at each deposit and withdrawal. Flat between them."));
      const plot = el("div", "plot");
      c.appendChild(plot);
      card.appendChild(c);
      linePlot(plot, {
        height: 170,
        yFormat: (v) => num(v, 0),
        series: [{
          name: "Principal", color: S2, step: true,
          points: p.series.map(s => ({ x: s.timestamp, y: s.principal, label: s.action })),
          markers: p.series.filter(s => s.action === "Supply" || s.action === "Withdraw")
            .map(s => ({ x: s.timestamp, y: s.principal })),
        }],
      });

      const curve = (p.interestCurve && p.interestCurve.length > 1) ? p.interestCurve : null;
      const ic = el("div", "chart");
      ic.appendChild(el("div", "chart-title", "Interest earned, cumulative"));
      ic.appendChild(el("div", "chart-note", curve
        ? "Aave accrues every block, so this rises continuously whether or not you touch the position. "
          + "Markers are your deposits and withdrawals."
        : "Credited at each event."));
      const iplot = el("div", "plot");
      ic.appendChild(iplot);
      card.appendChild(ic);
      linePlot(iplot, {
        height: 170,
        yFormat: (v) => num(v, Math.abs(p.interest) < 10 ? 4 : 2),
        series: [curve
          ? {
              name: "Interest", color: S1,
              points: curve.map(s => ({ x: s.timestamp, y: s.interest, label: s.action })),
              markers: curve.filter(s => s.action === "Supply" || s.action === "Withdraw")
                .map(s => ({ x: s.timestamp, y: s.interest })),
            }
          : {
              name: "Interest", color: S1, step: true,
              points: p.series.map(s => ({ x: s.timestamp, y: s.interest, label: s.action })),
            }],
      });
    }

    if (p.apySeries && p.apySeries.length > 1) {
      const c = el("div", "chart");
      c.appendChild(el("div", "chart-title", "The rate this pool paid while you held it"));
      c.appendChild(el("div", "chart-note",
        "Pool base rate, daily. Dashed rules are the compounded averages over your window."));
      const plot = el("div", "plot");
      c.appendChild(plot);
      card.appendChild(c);
      const rules = [];
      if (p.poolApy != null) rules.push({ y: p.poolApy * 100, color: S3, label: "pool " + pctS(p.poolApy) });
      if (p.myApy != null) rules.push({ y: p.myApy * 100, color: S1, label: "you " + pctS(p.myApy) });
      linePlot(plot, {
        height: 180,
        yFormat: (v) => v.toFixed(1) + "%",
        rules: rules,
        series: [{ name: "Pool rate", color: S3,
          points: p.apySeries.map(r => ({ x: r.timestamp, y: r.apyBase })) }],
      });
    }

    // The audit trail, so no figure above is left unexplained.
    const det = el("details");
    det.appendChild(el("summary", null, p.ledger.length + " events on this position"));
    const scroll = el("div", "scroll");
    scroll.innerHTML =
      "<table><thead><tr><th>Date</th><th>Action</th><th>Principal change</th>" +
      "<th>Interest credited</th><th>Tx</th></tr></thead><tbody>" +
      p.ledger.map(e =>
        "<tr><td>" + day(e.timestamp) + '</td><td class="name">' + e.action + "</td>" +
        '<td class="' + (e.principalDelta >= 0 ? "pos" : "neg") + '">' +
        (e.principalDelta >= 0 ? "+" : "") + num(e.principalDelta) + "</td>" +
        "<td>" + (e.interestRealized ? num(e.interestRealized) : "") + "</td>" +
        '<td><a href="' + txUrl(p.chainId, e.txHash) + '" target="_blank" rel="noopener">' +
        (e.txHash ? e.txHash.slice(0, 10) : "") + "</a></td></tr>").join("") +
      "</tbody></table>";
    det.appendChild(scroll);
    card.appendChild(det);
    return card;
  }

  /**
   * A position you have since exited earns one line, not a card.
   *
   * The scan already finds closed positions (the transfer sweep sees an aToken
   * that was touched even when the balance is now zero), and dust dominates them:
   * a 2 OP position held for an afternoon reads exactly like a real one if both
   * get the same card. So the strip is thresholded on the largest principal the
   * position ever held, valued at TODAY's price rather than the price while it was
   * open. That is an approximation, and it is the honest one available without a
   * historical price call per position: it can promote an asset that has since
   * appreciated and demote one that has fallen.
   */
  const CLOSED_MIN_USD = 10;

  function peakPrincipal(p) {
    let running = 0, peak = 0;
    for (const e of p.ledger) {
      running += e.principalDelta;
      if (running > peak) peak = running;
    }
    return peak;
  }

  function closedStrip(closed) {
    const sized = closed.map(p => {
      const peak = peakPrincipal(p);
      const dated = p.ledger.filter(e => e.timestamp);
      return {
        p: p,
        peakUsd: p.priceUsd != null ? peak * p.priceUsd : null,
        opened: dated.length ? dated[0].timestamp : null,
        // The last event on a position with no balance left is the exit.
        closed: dated.length ? dated[dated.length - 1].timestamp : null,
      };
    });

    // An unpriced asset cannot be judged against the threshold, so it is shown
    // rather than silently dropped.
    const shown = sized.filter(r => r.peakUsd == null || r.peakUsd >= CLOSED_MIN_USD)
      .sort((a, b) => (b.closed || 0) - (a.closed || 0));
    const hidden = sized.length - shown.length;

    const hiddenNote = hidden
      ? hidden + " smaller closed position" + (hidden === 1 ? "" : "s") +
        " not shown (never held $" + CLOSED_MIN_USD + ")."
      : "";

    if (shown.length === 0) {
      return hiddenNote ? el("p", "chart-note", hiddenNote) : null;
    }

    const suspect = shown.some(r => r.p.interestIsNegative || r.p.eventsComplete === false);
    const card = el("div", "card");
    card.appendChild(el("div", "chart-title", "Previously held"));
    card.appendChild(el("div", "chart-note",
      "Positions you have since exited, in token terms. " +
      "Sized by the most principal each one ever held, at today's price." +
      (suspect ? " A row marked ! has incomplete history, so its amount is unreliable." : "") +
      (hiddenNote ? " " + hiddenNote : "")));

    const scroll = el("div", "scroll");
    scroll.innerHTML =
      "<table><thead><tr><th>Chain</th><th>Asset</th><th>Earned</th>" +
      "<th>Opened</th><th>Closed</th></tr></thead><tbody>" +
      shown.map(r =>
        "<tr><td>" + r.p.chainName + (r.p.market && r.p.market !== "Core" ? " " + r.p.market : "") +
        '</td><td class="name"' +
        (r.p.interestIsNegative || r.p.eventsComplete === false
          ? ' title="The events found for this position do not reconcile against the contract, ' +
            'so the amount earned is unreliable."> ' + r.p.symbol + " !"
          : "> " + r.p.symbol) + "</td>" +
        '<td class="mono ' + (r.p.interest >= 0 ? "pos" : "neg") + '">' +
        (r.p.interest >= 0 ? "+" : "") + num(r.p.interest) + " " + r.p.symbol + "</td>" +
        "<td>" + day(r.opened) + "</td><td>" + day(r.closed) + "</td></tr>").join("") +
      "</tbody></table>";
    card.appendChild(scroll);
    return card;
  }

  function holdingsCard(DATA) {
    const totals = DATA.chains.map(c => ({
      name: c.name,
      kept: c.holdings.filter(h => h.kept),
      hidden: c.hiddenHoldings,
      truncated: c.sweep.truncated,
    }));
    const grand = totals.reduce((s, t) => s + t.kept.reduce((a, h) => a + (h.valueUsd || 0), 0), 0);

    const sum = el("div", "card");
    sum.appendChild(el("div", "chart-title", "Priced above $1, by chain"));
    sum.appendChild(el("div", "chart-note",
      "Total " + usd(grand) + ". " +
      totals.reduce((s, t) => s + t.hidden, 0) + " entries excluded as spam, dust or unpriced." +
      (totals.some(t => t.truncated) ? " History was truncated on at least one chain, so this is incomplete." : "")));

    const bars = el("div");
    const maxV = Math.max.apply(null, [1].concat(totals.map(t => t.kept.reduce((a, h) => a + (h.valueUsd || 0), 0))));
    totals.forEach(t => {
      const v = t.kept.reduce((a, h) => a + (h.valueUsd || 0), 0);
      const row = el("div");
      row.style.cssText = "display:flex;align-items:center;gap:12px;margin:8px 0;font-size:0.82rem";
      row.innerHTML =
        '<span style="width:76px;flex:none;color:var(--text-2)">' + t.name + "</span>" +
        '<span style="flex:1;min-width:0;background:var(--surface-2);border-radius:4px;height:16px;overflow:hidden">' +
        '<span style="display:block;height:100%;border-radius:4px;background:var(--series-1);width:' +
        ((v / maxV) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="mono" style="width:110px;flex:none;text-align:right">' + usd(v) + "</span>" +
        '<span class="mono" style="width:64px;flex:none;text-align:right;color:var(--text-3)">' + t.kept.length + " tok</span>";
      bars.appendChild(row);
    });
    sum.appendChild(bars);

    // Open loans, surfaced without pretending to account for them.
    const debts = DATA.chains.reduce((acc, c) =>
      acc.concat((c.debts || []).map(d => Object.assign({}, d, { chain: c.name }))), []);
    if (debts.length) {
      sum.appendChild(el("div", "warn",
        "<strong>Open Aave debt found.</strong> " +
        debts.map(d => d.amount.toLocaleString("en-US", { maximumFractionDigits: 2 }) +
          " " + d.symbol + " on " + d.chain + (d.valueUsd != null ? " (" + usd(d.valueUsd) + ")" : "")).join(", ") +
        ". Borrow-side interest is out of scope, so the returns above describe the supply legs only " +
        "and are not this wallet's net result."));
    }

    const det = el("details");
    det.appendChild(el("summary", null, "Every priced holding"));
    const scroll = el("div", "scroll");
    const rows = DATA.chains.reduce((acc, c) =>
      acc.concat(c.holdings.filter(h => h.kept).map(h => Object.assign({}, h, { chain: c.name }))), [])
      .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    scroll.innerHTML =
      "<table><thead><tr><th>Token</th><th>Chain</th><th>Amount</th><th>Price</th><th>Value</th><th>Confidence</th></tr></thead><tbody>" +
      rows.map(h =>
        '<tr><td class="name">' + (h.symbol || "?") + "</td><td>" + h.chain + "</td>" +
        "<td>" + num(h.amount, 4) + "</td><td>" + usd(h.priceUsd) + "</td><td>" + usd(h.valueUsd) + "</td>" +
        "<td>" + (h.confidence != null ? h.confidence.toFixed(2) : "—") + "</td></tr>").join("") +
      "</tbody></table>";
    det.appendChild(scroll);
    sum.appendChild(det);
    return sum;
  }

  function render(DATA, hosts) {
    const positionsHost = hosts.positions;
    const holdingsHost = hosts.holdings;
    positionsHost.innerHTML = "";
    holdingsHost.innerHTML = "";

    const positions = DATA.chains.reduce((acc, c) => acc.concat(c.positions), [])
      .sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0));

    if (positions.length === 0) {
      positionsHost.appendChild(el("p", "empty",
        "No Aave v3 Core-market positions found on the scanned chains. " +
        "Positions in the Prime, Horizon, Lido or EtherFi instances, or in Aave v2, are not scanned."));
    }
    // Open positions get the full card. An exited one gets a line in the strip
    // below them, so the page leads with money that is still at work.
    positions.filter(isLive).forEach(p => positionsHost.appendChild(positionCard(p)));

    const closed = positions.filter(p => !isLive(p));
    if (closed.length) {
      const strip = closedStrip(closed);
      if (strip) positionsHost.appendChild(strip);
    }

    holdingsHost.appendChild(el("h2", null, "Wallet holdings"));
    holdingsHost.appendChild(holdingsCard(DATA));
  }

  window.YieldLedger = { render: render };
})();
`;

/** Standalone dark HTML report with the scan result inlined. */
export function renderReport(result) {
  const payload = JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  ).replace(/</g, "\\u003c");

  const positions = result.chains.flatMap((c) => c.positions);
  const openCount = positions.filter((p) => p.isOpen && !p.isDust).length;
  const asOf = new Date(result.asOf * 1000).toISOString().slice(0, 16).replace("T", " ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yield Ledger</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>What your capital actually earned</h1>
  <p class="sub mono">${escapeHtml(result.address)}</p>
  <p class="sub">${positions.length} Aave v3 position${positions.length === 1 ? "" : "s"} (${openCount} open) across ${result.chains.map((c) => escapeHtml(c.name)).join(", ")} &middot; as of ${asOf} UTC &middot; ${result.stats.requests} requests in ${(result.stats.durationMs / 1000).toFixed(0)}s</p>

  <div id="positions"></div>
  <div id="holdings"></div>

  <footer>${METHODOLOGY_HTML}</footer>
</div>

<script id="payload" type="application/json">${payload}</script>
<script>${RENDER_SCRIPT}</script>
<script>
  window.YieldLedger.render(
    JSON.parse(document.getElementById("payload").textContent),
    { positions: document.getElementById("positions"), holdings: document.getElementById("holdings") }
  );
</script>
</body>
</html>`;
}
