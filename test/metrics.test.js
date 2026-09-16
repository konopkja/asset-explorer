import test from "node:test";
import assert from "node:assert/strict";
import { xirr, poolTwr, timeWeightedPrincipal, toUnits } from "../src/metrics.js";
import { principalFlow, accruedInterest, netPrincipal } from "../src/ledger.js";

const DAY = 86400;
const T0 = 1700000000;
const at = (days) => T0 + days * DAY;
const close = (actual, expected, tol, label) =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `${label}: got ${actual}, expected ~${expected} (tol ${tol})`,
  );

test("xirr: 1000 in, 1100 out one year later is exactly 10%", () => {
  const r = xirr([
    { timestamp: at(0), amount: -1000 },
    { timestamp: at(365), amount: 1100 },
  ]);
  close(r, 0.1, 1e-9, "10% case");
});

test("xirr: no gain is exactly zero", () => {
  const r = xirr([
    { timestamp: at(0), amount: -1000 },
    { timestamp: at(365), amount: 1000 },
  ]);
  close(r, 0, 1e-9, "flat case");
});

test("xirr: a loss returns a negative rate", () => {
  const r = xirr([
    { timestamp: at(0), amount: -1000 },
    { timestamp: at(365), amount: 900 },
  ]);
  close(r, -0.1, 1e-9, "loss case");
});

test("xirr: half-year double annualises to +300%", () => {
  // 2x over 182.5 days -> (1+r)^0.5 = 2 -> r = 3
  const r = xirr([
    { timestamp: at(0), amount: -100 },
    { timestamp: at(182.5), amount: 200 },
  ]);
  close(r, 3, 1e-6, "compounding case");
});

test("xirr: matches Microsoft's documented XIRR example", () => {
  // values {-10000, 2750, 4250, 3250, 2750} on 2008-01-01, 03-01, 10-30,
  // 2009-02-15, 04-01. Excel/Sheets return 0.3733625335 on a 365-day basis.
  const r = xirr([
    { timestamp: at(0), amount: -10000 },
    { timestamp: at(60), amount: 2750 },
    { timestamp: at(303), amount: 4250 },
    { timestamp: at(411), amount: 3250 },
    { timestamp: at(456), amount: 2750 },
  ]);
  close(r, 0.373362535, 1e-6, "Excel reference");
});

test("xirr: multiple deposits solve to a zero-NPV rate", () => {
  const flows = [
    { timestamp: at(0), amount: -1000 },
    { timestamp: at(365), amount: -1000 },
    { timestamp: at(730), amount: 2205 },
  ];
  const r = xirr(flows);
  const npv = flows.reduce(
    (s, f) => s + f.amount / (1 + r) ** ((f.timestamp - flows[0].timestamp) / (DAY * 365)),
    0,
  );
  close(npv, 0, 1e-6, "NPV at solved rate");
  close(r, 0.0668439, 1e-5, "closed-form root");
});

test("xirr: refuses impossible inputs instead of guessing", () => {
  assert.equal(xirr([{ timestamp: at(0), amount: -100 }]), null, "single flow");
  assert.equal(
    xirr([
      { timestamp: at(0), amount: -100 },
      { timestamp: at(365), amount: -100 },
    ]),
    null,
    "all one sign",
  );
  assert.equal(
    xirr([
      { timestamp: at(0), amount: -100 },
      { timestamp: at(0), amount: 100 },
    ]),
    null,
    "zero elapsed time",
  );
});

test("poolTwr: a flat 5% daily rate annualises to its compounded APY", () => {
  const series = Array.from({ length: 366 }, (_, i) => ({
    timestamp: at(i),
    apyBase: 5,
  }));
  const r = poolTwr(series, at(0), at(365));
  close(r, (1 + 0.05 / 365) ** 365 - 1, 1e-6, "flat 5%");
});

test("poolTwr: returns null rather than zero when history misses the window", () => {
  const series = Array.from({ length: 30 }, (_, i) => ({
    timestamp: at(300 + i),
    apyBase: 5,
  }));
  // Window starts long before the series does.
  assert.equal(poolTwr(series, at(0), at(330)), null, "uncovered window");
  assert.equal(poolTwr([], at(0), at(10)), null, "empty series");
  assert.equal(poolTwr(series, at(320), at(300)), null, "inverted window");
});

test("principalFlow: Mint nets out the interest baked into value", () => {
  // Aave emits Mint(value = principal + balanceIncrease)
  assert.equal(
    principalFlow({ kind: "Mint", value: 1100n, balanceIncrease: 100n }),
    1000n,
  );
});

test("principalFlow: a withdrawal smaller than accrued interest is a negative Mint", () => {
  // Withdrawing 40 with 100 of interest pending emits Mint(value = 100 - 40 = 60)
  assert.equal(
    principalFlow({ kind: "Mint", value: 60n, balanceIncrease: 100n }),
    -40n,
    "Mint must be able to remove principal",
  );
});

test("principalFlow: Burn adds back the interest netted out of value", () => {
  // Aave emits Burn(value = principal - balanceIncrease)
  assert.equal(
    principalFlow({ kind: "Burn", value: 900n, balanceIncrease: 100n }),
    -1000n,
  );
});

test("principalFlow: aToken transfers move principal at face value", () => {
  assert.equal(principalFlow({ kind: "TransferIn", value: 500n }), 500n);
  assert.equal(principalFlow({ kind: "TransferOut", value: 500n }), -500n);
});

test("accruedInterest: closes the balance identity exactly", () => {
  const ledger = [
    { kind: "Mint", principalDelta: 1000n, interestRealized: 0n },
    { kind: "Mint", principalDelta: 500n, interestRealized: 20n },
    { kind: "Burn", principalDelta: -300n, interestRealized: 10n },
  ];
  assert.equal(netPrincipal(ledger), 1200n);
  // Balance of 1275 over 1200 net principal = 75 lifetime interest.
  assert.equal(accruedInterest(1275n, ledger), 75n);
});

test("accruedInterest: clamps ray-rounding dust but surfaces real negatives", () => {
  const ledger = [
    { principalDelta: 1000n, interestRealized: 0n },
    { principalDelta: 0n, interestRealized: 0n },
  ];
  assert.equal(accruedInterest(998n, ledger), 0n, "2 wei short on 2 events is dust");
  assert.equal(accruedInterest(900n, ledger), -100n, "100 wei short is a real problem");
});

test("timeWeightedPrincipal: separates elapsed time from deployed time", () => {
  const ledger = [
    { timestamp: at(0), principalDelta: 1000n },   // in
    { timestamp: at(100), principalDelta: -1000n }, // fully out at day 100
    { timestamp: at(300), principalDelta: 1000n },  // back in at day 300
  ];
  const r = timeWeightedPrincipal(ledger, 0, at(400));
  close(r.days, 400, 1e-6, "elapsed");
  close(r.deployedDays, 200, 1e-6, "deployed (0-100 and 300-400)");
  // 1000 for 100d + 0 for 200d + 1000 for 100d, over 400d = 500 average
  close(r.averagePrincipal, 500, 1e-6, "average principal");
});

test("toUnits: scales base units by decimals", () => {
  assert.equal(toUnits(1500000n, 6), 1.5);
  assert.equal(toUnits(10n ** 18n, 18), 1);
});
