import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import test from "node:test";
import type { ActionIntent, PortfolioPosition, Signal } from "@rpm/shared";
import { encodeAbiParameters } from "viem";
import { decide } from "../src/orchestrator/consensus.js";
import { checkAll, validateActionParameters } from "../src/constraints/constraints.js";
import { AnalystAgent, parseActionProposals } from "../src/agents/analystAgent.js";
import { findNavUsdE6 } from "../src/fdc/fdcAdapter.js";
import { extractNavUsd } from "../src/observe/index.js";
import { observeOnchain } from "../src/observe/onchainObserver.js";
import { computeRiskScore } from "../src/risk/riskSentinel.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { CONFIG } from "../src/config.js";
import { Effect, createHttpClient } from "../../../packages/shared/src/effects.js";

const hedge: ActionIntent = {
  type: "HEDGE", reason: "Reduce exposure in a legacy simulation",
  params: { against: "tBILL", instrument: "demo-hedge", notionalPct: 0.02, slippageBps: 25 },
};
const position: PortfolioPosition = { assetId: "demo", symbol: "tBILL", quantity: "100", price: "1", value: "100" };
const context = { positions: [position], riskScore: 10, dynamic: { defensiveMode: true, maxTurnover: 0.05, maxSlippageBps: 50 } };
function signal(agent: string, changes: Partial<Signal> = {}): Signal {
  return { agent, kind: "RISK", severity: "INFO", summary: "Test", details: {}, confidence: 1,
    stance: "SUPPORT", recommendations: [hedge], createdAt: "2026-01-01T00:00:00.000Z", ...changes };
}

test("one agent cannot multiply its vote with duplicate actions or reports", () => {
  const cfg = { weights: { a: 0.2, b: 0.4, c: 0.4 }, rule: { thresholdWeight: 0.67 } };
  const repeated = signal("a", { recommendations: Array(10).fill(hedge) });
  const decision = decide(cfg, Array(10).fill(repeated), 10);
  assert.equal(decision.approvedActions.length, 0);
  assert.equal(decision.consensus!.escalated[0].supportWeight, 0.2);
  assert.deepEqual(decision.consensus!.escalated[0].supportAgents, ["a"]);
});

test("neutral and opposing proposals do not count as support", () => {
  const cfg = { weights: { a: 1 }, rule: { thresholdWeight: 0.67 } };
  for (const stance of ["NEUTRAL", "OPPOSE"] as const) {
    const decision = decide(cfg, [signal("a", { stance })], 10);
    assert.equal(decision.approvedActions.length, 0);
  }
  const conflict = decide(cfg, [signal("a"), signal("a", { stance: "OPPOSE" })], 10);
  assert.equal(conflict.consensus!.denied[0].supportWeight, 0);
});

test("quorum scales with the effective electorate rather than absolute reputation weights", () => {
  const cfg = { weights: { a: 0.5, b: 0.5 }, rule: { thresholdWeight: 0.67 } };
  assert.equal(decide(cfg, [signal("a")], 10, { a: 1.5, b: 1.5 }).approvedActions.length, 0);
  assert.equal(decide(cfg, [signal("a")], 10, { a: 0.3, b: 0.1 }).approvedActions.length, 1);
  assert.equal(decide(cfg, [signal("a"), signal("b")], 10).approvedActions.length, 1);
});

test("invalid confidence cannot inflate influence and unknown risk escalates", () => {
  const cfg = { weights: { a: 1 }, rule: { thresholdWeight: 0.67 } };
  for (const confidence of [NaN, Infinity, 2, -1]) {
    assert.equal(decide(cfg, [signal("a", { confidence })], 10).approvedActions.length, 0);
  }
  assert.equal(decide(cfg, [signal("a")], NaN).escalationRequired, true);
  assert.throws(() => decide(cfg, [], 10, { a: NaN }), /weights/);
  assert.throws(() => decide(cfg, [], 10, { a: 0 }), /electorate/);
});

test("opposition votes and compliance vetoes are deduplicated", () => {
  const cfg = { weights: { a: 0.4, b: 0.6 }, rule: { thresholdWeight: 0.67, vetoAgents: ["b"] } };
  const opposing = signal("b", { stance: "OPPOSE", veto: true, recommendations: [] });
  const decision = decide(cfg, [signal("a"), opposing, opposing], 10);
  assert.deepEqual(decision.consensus!.denied[0].opposeAgents, ["b"]);
  assert.equal(decision.consensus!.denied[0].opposeWeight, 0.6);
});

test("action sizes require finite numeric types and are capped", () => {
  for (const notionalPct of [5, "0.02", NaN, Infinity, 0, -0.1]) {
    const action = { ...hedge, params: { ...hedge.params, notionalPct, turnover: 0 } };
    assert.equal(checkAll(action, context).ok, false);
    assert.deepEqual(parseActionProposals({ actions: [action] }), []);
  }
  assert.equal(checkAll(hedge, context).ok, true);
  assert.equal(parseActionProposals({ actions: [hedge] }).length, 1);
  assert.deepEqual(parseActionProposals({ actions: [{ ...hedge, unexpected: true }] }), []);
  assert.equal(validateActionParameters({ ...hedge, params: [] as never }).ok, false);
  assert.equal(validateActionParameters({ ...hedge, params: { ...hedge.params, invented: true } }).ok, false);
});

test("defensive turnover is derived from notional, not the supplied turnover", () => {
  const action = { ...hedge, params: { ...hedge.params, notionalPct: 0.15, turnover: 0 } };
  const result = checkAll(action, context);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, "DEFENSIVE_TURNOVER_LIMIT");
});

test("each action family rejects invalid bounds and privileged actions require approval", () => {
  const rebalance: ActionIntent = { type: "REBALANCE", reason: "test", params: { asset: "tBILL", targetDeltaPct: -0.3, slippageBps: 25 } };
  const redeem: ActionIntent = { type: "REDEEM", reason: "test", params: { assetClass: "credit", amountPct: "0.1" } };
  assert.equal(checkAll(rebalance, context).ok, false);
  assert.equal(checkAll(redeem, context).ok, false);
  assert.equal(checkAll({ ...hedge, params: { ...hedge.params, slippageBps: NaN } }, context).ok, false);
  assert.equal(checkAll({ type: "UNPAUSE", reason: "test", params: {} }, context).ok, false);
  assert.equal(checkAll({ type: "UPDATE_CONSTRAINTS", reason: "test", params: { maxTurnover: 0.1 } }, context).ok, false);
  assert.equal(checkAll(hedge, { ...context, riskScore: NaN }).ok, false);
  assert.equal(checkAll({ type: "PAUSE", reason: "Unknown risk", params: {} }, { ...context, riskScore: NaN }).ok, true);
});

test("NAV decoder accepts only explicit NAV fields and rejects unrelated numbers", () => {
  assert.equal(findNavUsdE6({ votingRound: 12345, responseBody: { response: { nav_usd_e6: 1040000 } } }), 1040000);
  assert.equal(findNavUsdE6({ name: "R2-D2", height: 96, numberOfFilms: 6 }), null);
  assert.equal(findNavUsdE6({ nav_usd_e6: "1040000" }), 1040000);
  for (const value of [0, -1, NaN, Infinity, null, "", "1.04", true]) {
    assert.equal(findNavUsdE6({ nav_usd_e6: value }), null);
  }
  assert.equal(findNavUsdE6({ nav_usd_e6: 1040000, response: { nav_usd_e6: 2040000 } }), null);
});

test("NAV ABI decoding supports the documented tuple and rejects a different schema", t => {
  const original = CONFIG.fdcWeb2Abi;
  t.after(() => { CONFIG.fdcWeb2Abi = original; });
  CONFIG.fdcWeb2Abi = JSON.stringify({ type: "tuple", components: [{ name: "ts", type: "uint256" }, { name: "nav_usd_e6", type: "uint256" }] });
  const encoded = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1700000000n, 1040000n]);
  const payload = { votingRound: 12345, responseBody: { abi_encoded_data: encoded } };
  assert.equal(findNavUsdE6(payload), 1040000);
  CONFIG.fdcWeb2Abi = JSON.stringify({ type: "tuple", components: [{ name: "height", type: "uint256" }, { name: "mass", type: "uint256" }] });
  assert.equal(findNavUsdE6(payload), null);
});

test("string micro-dollar NAV is scaled consistently", () => {
  const data = [{ key: "nav", value: { nav_usd_e6: "1040000" }, observedAt: "test", source: "fixture", confidence: 1 }];
  assert.equal(extractNavUsd(data, "nav"), 1.04);
});

test("price outages and incomplete quotes fail rather than producing zero-valued holdings", async t => {
  const original = { coingeckoIds: CONFIG.coingeckoIds, coingeckoSymbols: CONFIG.coingeckoSymbols, coingeckoVsCurrency: CONFIG.coingeckoVsCurrency };
  Object.assign(CONFIG, { coingeckoIds: "bill,estate", coingeckoSymbols: "tBILL,tRE", coingeckoVsCurrency: "usd" });
  t.after(() => Object.assign(CONFIG, original));
  let payload: unknown = {};
  let status = 200;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    return new Response(JSON.stringify(payload), { status });
  });
  await assert.rejects(observeOnchain(), /invalid price/);
  for (const value of [0, null, "1", -1]) {
    payload = { bill: { usd: value }, estate: { usd: 10 } };
    await assert.rejects(observeOnchain(), /invalid price/);
  }
  status = 429;
  await assert.rejects(observeOnchain(), /HTTP 429/);
  status = 200;
  payload = { bill: { usd: 1.04 }, estate: { usd: 10 } };
  const result = await observeOnchain();
  assert.equal(result.positions[0].price, "1.04");
  assert.equal(result.positions[1].price, "10");
});

test("unpriced, inconsistent and zero-NAV portfolios do not get a reassuring risk score", () => {
  const inputs = { liquidityStress: 0.2, creditScore: 0.15 };
  for (const positions of [[], [{ ...position, price: "0" }], [{ ...position, value: "NaN" }],
    [{ ...position, price: "0x1" }], [{ ...position, value: "99" }], [{ ...position, quantity: "0", value: "0" }]]) {
    assert.throws(() => computeRiskScore(positions, inputs), /Risk is unknown/);
  }
  assert.throws(() => computeRiskScore([position]), /Risk is unknown/);
  assert.throws(() => computeRiskScore([position], { ...inputs, creditScore: NaN }), /Risk is unknown/);
  assert.ok(Number.isFinite(computeRiskScore([position], inputs).score));
});

test("malformed model responses produce no recommendations and use a request deadline", async t => {
  const original = CONFIG.llmEnabled;
  CONFIG.llmEnabled = false;
  t.after(() => { CONFIG.llmEnabled = original; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    return new Response(JSON.stringify({ suggestions: "invalid" }));
  });
  const [report] = await new AnalystAgent().run({ positions: [position], data: [] });
  assert.deepEqual(report.recommendations, []);
  assert.match(String(report.details.modelError), /schema/);
});

test("sleep releases its AbortSignal listener after completion and cancellation", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 25; i++) await Effect.sleep(0)({}, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = Effect.sleep(10_000)({}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("HTTP helper combines caller cancellation with its request timeout", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    assert.notEqual(init.signal, controller.signal);
    controller.abort();
    assert.equal(init.signal!.aborted, true);
    return new Response("{}");
  });
  await createHttpClient().getJson("https://fixture.invalid", { signal: controller.signal });
});

test("audit writer rejects non-records and prevents caller timestamp override", t => {
  let line = "";
  t.mock.method(fs, "appendFileSync", (_path: unknown, value: string) => { line = value; });
  const audit = new AuditLog("unused-test-file");
  for (const value of [null, [], "text", 1]) assert.throws(() => audit.append(value), /objects/);
  audit.append({ type: "test", ts: "forged" });
  assert.equal(JSON.parse(line).type, "test");
  assert.notEqual(JSON.parse(line).ts, "forged");
});
