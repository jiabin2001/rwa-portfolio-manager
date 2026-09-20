import test from "node:test";
import assert from "node:assert/strict";
import { PAPER_SCENARIOS, type PaperApiState } from "@rpm/shared";
import { runPaper } from "../../middleware/src/paper/engine.js";
import { formatMoney, formatPercent, parsePaperState, stageResult } from "../src/presentation.js";

function response(scenario: Parameters<typeof runPaper>[0] = "normal"): PaperApiState {
  return { ok: true, mode: "PAPER", liveExecutionEnabled: false, run: runPaper(scenario) };
}

test("every deterministic scenario survives the API boundary without losing its outcome", () => {
  for (const scenario of PAPER_SCENARIOS) {
    const value = response(scenario.id);
    const parsed = parsePaperState(JSON.parse(JSON.stringify(value)));
    assert.deepEqual(parsed, value);
  }
});

test("missing and stale prices display UNKNOWN, never a fabricated zero risk or valuation", () => {
  for (const scenario of ["missing-price", "stale-price"] as const) {
    const { run } = parsePaperState(response(scenario));
    assert.equal(formatMoney(run.equityBeforeCents), "UNKNOWN");
    assert.equal(formatMoney(run.equityAfterCents), "UNKNOWN");
    assert.equal(formatPercent(run.riskAfter?.historicalVar95Pct), "UNKNOWN");
    assert.equal(formatPercent(run.riskBefore?.concentration, true), "UNKNOWN");
    assert.equal(stageResult(run, "EXECUTION"), "NOT_REACHED");
  }
  assert.equal(formatPercent(0), "0.00%", "a measured zero remains distinguishable from unknown");
});

test("approved consensus must not be presented as executed when constraints reject the trade", () => {
  const { run } = parsePaperState(response("invalid-action"));
  assert.equal(run.consensus?.status, "APPROVED");
  assert.equal(stageResult(run, "CONSTRAINTS"), "DENIED");
  assert.equal(stageResult(run, "EXECUTION"), "NOT_REACHED");
  assert.equal(run.status, "BLOCKED");
  assert.equal(run.fills.length, 0);
  assert.deepEqual(run.after, run.before);
});

test("a failed fill stays failed even though both gates and reconciliation pass", () => {
  const { run } = parsePaperState(response("execution-failure"));
  assert.equal(run.consensus?.status, "APPROVED");
  assert.equal(stageResult(run, "CONSTRAINTS"), "APPROVED");
  assert.equal(stageResult(run, "EXECUTION"), "FAILED");
  assert.equal(stageResult(run, "RECONCILIATION"), "PASS");
  assert.equal(run.status, "FAILED");
});

test("reject live mode, wrong schema, invalid cents, non-finite risk, and malformed nested fields", () => {
  const cases: Array<[string[], unknown]> = [
    [["mode"], "LIVE"],
    [["liveExecutionEnabled"], true],
    [["run", "schemaVersion"], 2],
    [["run", "before", "cashCents"], 1.5],
    [["run", "riskAfter", "historicalVar95Pct"], NaN],
    [["run", "audit", "0", "stage"], "UNRECOGNIZED"],
    [["run", "consensus", "votes"], {}],
    [["run", "fills", "0", "priceCents"], "100"],
    [["run", "reconciliation", "ok"], "true"],
  ];
  for (const [path, replacement] of cases) {
    const value = response();
    let parent = value as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[path.at(-1)!] = replacement;
    assert.throws(() => parsePaperState(value), /incompatible paper replay/);
  }
});

test("concentration fractions and risk percentages keep their distinct units", () => {
  assert.equal(formatPercent(0.58, true), "58.00%");
  assert.equal(formatPercent(1.23), "1.23%");
  assert.equal(formatMoney(12345), "$123.45");
});
