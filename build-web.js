#!/usr/bin/env node
/**
 * Build the single-file browser app.
 *
 * The accounting modules are ES modules shared with the CLI, and they are
 * inlined here rather than copied, so there is exactly one implementation of the
 * ledger and the rate maths. Inlining (instead of `<script type="module">` with
 * imports) is what lets the output run from `file://`, where cross-origin module
 * imports are blocked.
 *
 * The transform is deliberately dumb: drop local `import` statements, drop
 * `export { ... }` re-export lines, and strip a leading `export ` keyword. That
 * is sound only because these files import nothing but each other and declare no
 * colliding top-level names, both of which are asserted below.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAINS } from "./src/chains.js";
import { reservesFor } from "./src/reserves.js";
import { REPORT_CSS, RENDER_SCRIPT, METHODOLOGY_HTML } from "./src/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Dependency order matters: a name must be declared before it is used at runtime. */
const MODULES = [
  "chains.js",
  "decode.js",
  "ledger.js",
  "metrics.js",
  "llama.js",
  "rpc.js",
  "scan.js",
  "client-web.js",
];

/** Strip module syntax, line by line, so multi-line imports are handled exactly. */
function stripModuleSyntax(source, file) {
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    // import ... from "./x.js";  possibly spanning several lines
    if (/^import\b/.test(line)) {
      while (!/from\s+["'][^"']+["'];?\s*$/.test(lines[i]) && i < lines.length - 1) i += 1;
      const from = lines[i].match(/from\s+["']([^"']+)["']/);
      if (from && !from[1].startsWith(".")) {
        throw new Error(`${file} imports a package (${from[1]}); it cannot be inlined`);
      }
      continue;
    }
    // export { A, B };  (re-exports carry no declaration, so they just go)
    if (/^export\s*\{[^}]*\}\s*(from\s+["'][^"']+["'])?\s*;?\s*$/.test(line)) continue;
    // export const / function / async function ...
    line = line.replace(/^export\s+/, "");
    out.push(line);
  }
  return out.join("\n");
}

/** Guard the one real risk of concatenating modules into a single scope. */
function assertNoCollisions(pieces) {
  const seen = new Map();
  const declaration = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/;
  for (const { file, code } of pieces) {
    for (const line of code.split("\n")) {
      const match = line.match(declaration);
      if (!match) continue;
      const name = match[1];
      if (seen.has(name)) {
        throw new Error(
          `top-level name "${name}" declared in both ${seen.get(name)} and ${file}; ` +
            `inlining would shadow one of them`,
        );
      }
      seen.set(name, file);
    }
  }
  return seen.size;
}

const pieces = MODULES.map((file) => ({
  file,
  code: stripModuleSyntax(fs.readFileSync(path.join(here, "src", file), "utf8"), file),
}));
const declared = assertNoCollisions(pieces);

const bundle = pieces
  .map(({ file, code }) => `// ---- src/${file} ${"-".repeat(Math.max(0, 60 - file.length))}\n${code}`)
  .join("\n\n");

// The Aave address book is a Node package, so its reserve table is baked in as
// data. This is also what keeps the app keyless: no runtime reserve discovery.
const RESERVES = Object.fromEntries(CHAINS.map((c) => [c.id, reservesFor(c.id)]));
const reserveCount = Object.values(RESERVES).reduce((n, r) => n + r.length, 0);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yield Ledger</title>
<style>${REPORT_CSS}
  .intro { max-width: 62ch; color: var(--text-2); font-size: 0.9rem; margin: 10px 0 26px; }
  form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  input[type=text] {
    flex: 1 1 320px; min-width: 0;
    background: var(--surface-1); color: var(--text-1);
    border: 1px solid var(--line); border-radius: 9px;
    padding: 11px 14px; font-family: var(--mono); font-size: 0.95rem;
  }
  input[type=text]:focus { outline: 2px solid var(--series-1); outline-offset: -1px; }
  button {
    background: var(--series-1); color: #fff; border: 0; border-radius: 9px;
    padding: 11px 20px; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    font-family: inherit;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.ghost { background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line); }
  .chains { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; font-size: 0.85rem; color: var(--text-2); }
  .chains label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .status { font-size: 0.85rem; color: var(--text-2); font-family: var(--mono); }
  .status:empty { display: none; }
  .status.error { color: var(--bad); font-family: var(--sans); }
  .meta { font-size: 0.85rem; color: var(--text-3); margin-bottom: 20px; }
  .meta:empty { display: none; }
  /* Only present while a scan is running, so a finished report is not topped by
     a full-width bar that looks like part of the result. */
  .bar { height: 3px; background: var(--surface-2); border-radius: 2px; overflow: hidden; margin-bottom: 18px; }
  .bar:not(.active) { display: none; }
  .bar span { display: block; height: 100%; width: 0; background: var(--series-1); transition: width 200ms linear; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>What your capital actually earned</h1>
  <p class="intro">
    Paste an address or ENS name. This reads your Aave v3 supply history straight from
    the chain and works out the rate <em>you</em> actually got, next to the rate the pool
    was paying over the same days. Runs entirely in your browser against public block
    explorers: no key, no server, nothing sent anywhere but the explorers themselves.
  </p>

  <form id="form">
    <input id="addr" type="text" placeholder="vitalik.eth or 0x..." autocomplete="off"
           spellcheck="false" autocapitalize="off">
    <button id="go" type="submit">Scan</button>
  </form>
  <div class="chains" id="chains"></div>

  <div class="bar" id="bar"><span id="progress"></span></div>
  <div class="status" id="status"></div>
  <div class="meta" id="meta"></div>

  <div id="positions"></div>
  <div id="holdings"></div>
  <div class="actions" id="actions"></div>

  <footer>${METHODOLOGY_HTML}
    <h2>Where the data comes from</h2>
    <ul>
      <li>Event history, balances and ENS: the public Blockscout instance for each chain
        (Optimism's is <code>explorer.optimism.io</code>).</li>
      <li>Pool rate history and token prices: DefiLlama.</li>
      <li>${reserveCount} Aave v3 Core reserves across ${CHAINS.length} chains are compiled into this page
        from <code>@bgd-labs/aave-address-book</code>, so nothing has to be discovered at runtime.</li>
      <li>The ledger and rate maths in this page are the same source as the command-line
        version, inlined at build time rather than reimplemented.</li>
    </ul>
  </footer>
</div>

<script>
const RESERVES = ${JSON.stringify(RESERVES)};
</script>
<script>${RENDER_SCRIPT}</script>
<script>
${bundle}

// ---- app ------------------------------------------------------------------
(function () {
  const form = document.getElementById("form");
  const input = document.getElementById("addr");
  const go = document.getElementById("go");
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const progress = document.getElementById("progress");
  const bar = document.getElementById("bar");
  const chainsEl = document.getElementById("chains");
  const actions = document.getElementById("actions");
  const hosts = {
    positions: document.getElementById("positions"),
    holdings: document.getElementById("holdings"),
  };

  CHAINS.forEach(function (c) {
    const id = "chain-" + c.id;
    const label = document.createElement("label");
    label.innerHTML = '<input type="checkbox" id="' + id + '" value="' + c.id + '" checked> ' + c.name;
    chainsEl.appendChild(label);
  });

  const selectedChains = () => CHAINS.filter(
    (c) => document.getElementById("chain-" + c.id).checked);

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "status error" : "status";
  }

  // The scan is a known number of steps per chain, so progress is real rather
  // than an indeterminate spinner: two discovery calls plus one per position.
  let done = 0;
  let expected = 1;
  function bump() {
    done += 1;
    progress.style.width = Math.min(97, (done / expected) * 100) + "%";
  }

  let lastResult = null;

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const chains = selectedChains();
    if (chains.length === 0) { setStatus("Pick at least one chain.", true); return; }

    go.disabled = true;
    hosts.positions.innerHTML = "";
    hosts.holdings.innerHTML = "";
    actions.innerHTML = "";
    metaEl.textContent = "";
    done = 0;
    expected = chains.length * 4;
    progress.style.width = "2%";
    bar.classList.add("active");

    try {
      setStatus("resolving " + raw);
      const resolved = await resolveAddress(raw);
      if (resolved.inexact && resolved.ens) {
        setStatus('no exact ENS match; using ' + resolved.ens);
      }
      webClient.resetRequestCount();

      const result = await scanAddress(webClient, resolved.address, {
        chains: chains,
        // Each chain has its own explorer host, so running them together costs
        // no single host any extra load and cuts wall-clock roughly fourfold.
        chainConcurrency: chains.length,
        onProgress: function (message) { setStatus(message); bump(); },
      });
      lastResult = result;

      bar.classList.remove("active");
      const positions = result.chains.reduce((a, c) => a.concat(c.positions), []);
      const open = positions.filter((p) => p.isOpen).length;
      setStatus("");
      metaEl.innerHTML =
        '<span class="mono">' + (resolved.ens ? resolved.ens + " &middot; " : "") +
        result.address + "</span><br>" +
        positions.length + " Aave v3 position" + (positions.length === 1 ? "" : "s") +
        " (" + open + " open) across " + result.chains.map((c) => c.name).join(", ") +
        " &middot; " + result.stats.requests + " requests in " +
        (result.stats.durationMs / 1000).toFixed(0) + "s";

      window.YieldLedger.render(result, hosts);

      const dl = document.createElement("button");
      dl.className = "ghost";
      dl.type = "button";
      dl.textContent = "Download JSON";
      dl.addEventListener("click", function () {
        const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "yield-ledger-" + result.address.slice(0, 10) + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
      });
      actions.appendChild(dl);
    } catch (err) {
      bar.classList.remove("active");
      setStatus(err && err.message ? err.message : String(err), true);
    } finally {
      go.disabled = false;
    }
  });

  // Deep link: index.html#vitalik.eth scans on load.
  if (location.hash.length > 1) {
    input.value = decodeURIComponent(location.hash.slice(1));
    form.dispatchEvent(new Event("submit"));
  }
})();
</script>
</body>
</html>`;

const outDir = path.join(here, "web");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "index.html");
fs.writeFileSync(outFile, html);

console.log(`built ${outFile}`);
console.log(`  ${(html.length / 1024).toFixed(0)} KB, ${declared} inlined declarations`);
console.log(`  ${reserveCount} reserves across ${CHAINS.length} chains baked in`);
console.log(`  modules inlined: ${MODULES.join(", ")}`);
