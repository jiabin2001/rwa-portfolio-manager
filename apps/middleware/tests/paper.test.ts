import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_SCENARIOS,
  type PaperAction,
  type PaperAuditEvent,
  type PaperScenarioId,
  type PaperVote,
} from "@rpm/shared";
import {
  canonical,
  checkAction,
  consensus,
  DATASET_HASH,
  digest,
  equity,
  integer,
  PaperBroker,
  POLICY_HASH,
  replayAudit,
  risk,
  runPaper,
  validateData,
} from "../src/paper/engine.js";
import { FIXTURE } from "../src/paper/fixture.js";

const expectedStatus = {
  normal: "CONFIRMED",
  "missing-price": "BLOCKED",
  "stale-price": "BLOCKED",
  "invalid-action": "BLOCKED",
  "insufficient-consensus": "ESCALATED",
  "execution-failure": "FAILED",
  "duplicate-vote": "CONFIRMED",
} as const;
const expectedStages: Record<PaperScenarioId, string[]> = {
  normal: [
    "DATA",
    "RISK",
    "PROPOSAL",
    "CONSENSUS",
    "CONSTRAINTS",
    "EXECUTION",
    "RECONCILIATION",
  ],
  "duplicate-vote": [
    "DATA",
    "RISK",
    "PROPOSAL",
    "CONSENSUS",
    "CONSTRAINTS",
    "EXECUTION",
    "RECONCILIATION",
  ],
  "missing-price": ["DATA", "RISK", "RECONCILIATION"],
  "stale-price": ["DATA", "RISK", "RECONCILIATION"],
  "invalid-action": [
    "DATA",
    "RISK",
    "PROPOSAL",
    "CONSENSUS",
    "CONSTRAINTS",
    "RECONCILIATION",
  ],
  "insufficient-consensus": [
    "DATA",
    "RISK",
    "PROPOSAL",
    "CONSENSUS",
    "RECONCILIATION",
  ],
  "execution-failure": [
    "DATA",
    "RISK",
    "PROPOSAL",
    "CONSENSUS",
    "CONSTRAINTS",
    "EXECUTION",
    "RECONCILIATION",
  ],
};
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
function rehash(events: PaperAuditEvent[]): PaperAuditEvent[] {
  let previousHash = "0".repeat(64);
  return events.map((event, i) => {
    const { hash: _hash, ...rest } = event;
    const body = { ...rest, sequence: i + 1, previousHash };
    const next = { ...body, hash: digest(body) };
    previousHash = next.hash;
    return next;
  });
}
function vote(
  action: PaperAction,
  agentId: string,
  stance: PaperVote["stance"] = "SUPPORT",
): PaperVote {
  return { actionId: action.actionId, agentId, stance, reason: "test fixture" };
}

test("all seven published scenarios have deterministic outcomes and complete audit stages", () => {
  assert.deepEqual(
    PAPER_SCENARIOS.map((s) => s.id).sort(),
    Object.keys(expectedStatus).sort(),
  );
  const ids = new Set<string>();
  for (const { id } of PAPER_SCENARIOS) {
    const run = runPaper(id);
    assert.equal(run.status, expectedStatus[id]);
    assert.equal(run.mode, "PAPER");
    assert.equal(run.datasetHash, DATASET_HASH);
    assert.equal(run.policyHash, POLICY_HASH);
    assert.equal(run.reconciliation.ok, true);
    assert.deepEqual(
      run.audit.map((e) => e.stage),
      expectedStages[id],
    );
    assert.equal(run.audit.at(-1)!.hash, run.auditHead);
    assert.equal(
      JSON.stringify(run),
      JSON.stringify(runPaper(id)),
      `${id} is not byte-identical on repeat`,
    );
    assert.deepEqual(replayAudit(run.audit, run.auditHead), run);
    ids.add(run.runId);
    if (run.status !== "CONFIRMED") {
      assert.deepEqual(run.after, run.before);
      assert.deepEqual(run.fills, []);
      assert.equal(run.reconciliation.cashDeltaCents, 0);
      assert.equal(run.reconciliation.expectedCostCents, 0);
    }
  }
  assert.equal(ids.size, 7);
});

test("normal fill reconciles exact integer-cent money and unit balances", () => {
  const run = runPaper("normal");
  const fill = run.fills[0];
  assert.deepEqual(
    {
      type: run.action!.type,
      asset: run.action!.assetId,
      units: run.action!.units,
      limit: run.action!.limitPriceCents,
    },
    { type: "SELL", asset: "TRES", units: 1261, limit: 10099 },
  );
  assert.equal(fill.units, 1261);
  assert.equal(fill.priceCents, 10109);
  assert.equal(fill.grossCents, 12747449);
  assert.equal(fill.feeCents, 6373);
  assert.equal(fill.slippageCostCents, 13871);
  assert.deepEqual(run.after, {
    cashCents: 22741076,
    units: { TRES: 5739, PROP: 2000 },
  });
  assert.equal(run.equityBeforeCents, 100140000);
  assert.equal(run.equityAfterCents, 100119756);
  assert.deepEqual(run.reconciliation, {
    ok: true,
    cashDeltaCents: 12741076,
    equityChangeCents: -20244,
    expectedCostCents: 20244,
    unitsConserved: true,
  });
  assert.equal(
    equity(run.after, run.pricesCents) - equity(run.before, run.pricesCents),
    -(fill.feeCents + fill.slippageCostCents),
  );
});

test("historical fixed-holdings risk is numerical, repeatable and does not promise every metric improves", () => {
  const run = runPaper();
  assert.equal(run.riskBefore!.samples, 30);
  assert.equal(run.riskBefore!.method, "historical-simulation");
  assert.equal(run.riskBefore!.source, "synthetic-fixture");
  near(run.riskBefore!.concentration, 0.707409626522868);
  near(run.riskAfter!.concentration, 0.5800921048988573);
  near(run.riskBefore!.historicalVar95Pct, 0.21155995529299476);
  near(run.riskBefore!.historicalEs95Pct, 0.2115810715898836);
  near(run.riskBefore!.maxDrawdownPct, 0.6222576785002043);
  near(run.riskAfter!.historicalVar95Pct, 0.21637580554737523);
  assert.ok(run.riskAfter!.concentration < run.riskBefore!.concentration);
  assert.ok(
    run.riskAfter!.historicalVar95Pct > run.riskBefore!.historicalVar95Pct,
  );
});

test("missing and stale data keep valuation and risk unknown without fabricating a low score", () => {
  for (const scenario of ["missing-price", "stale-price"] as const) {
    const run = runPaper(scenario);
    assert.equal(
      run.dataQuality,
      scenario === "missing-price" ? "MISSING" : "STALE",
    );
    assert.equal(run.equityBeforeCents, null);
    assert.equal(run.equityAfterCents, null);
    assert.equal(run.riskBefore, null);
    assert.equal(run.riskAfter, null);
    assert.equal(run.action, null);
    assert.equal(run.consensus, null);
    assert.equal(run.reconciliation.equityChangeCents, null);
  }
});

test("data quality rejects invalid prices, timestamps, units and history", () => {
  const {
    pricesCents: prices,
    observedAt,
    asOf,
    initialLedger: ledger,
    historyCents: history,
  } = FIXTURE;
  assert.equal(
    validateData(prices, observedAt, asOf, ledger, history),
    "VALID",
  );
  for (const value of [0, -1, NaN, Infinity, 1.5, "10120"] as unknown[]) {
    assert.equal(
      validateData(
        { ...prices, TRES: value as number },
        observedAt,
        asOf,
        ledger,
        history,
      ),
      "INVALID",
    );
  }
  assert.equal(
    validateData({ TRES: 10120 }, observedAt, asOf, ledger, history),
    "MISSING",
  );
  assert.equal(
    validateData(prices, "invalid", asOf, ledger, history),
    "INVALID",
  );
  assert.equal(
    validateData(prices, "2026-02-01T16:00:00Z", asOf, ledger, history),
    "INVALID",
  );
  assert.equal(
    validateData(prices, "2026-01-31T15:54:59Z", asOf, ledger, history),
    "STALE",
  );
  assert.equal(
    validateData(prices, "2026-01-31T15:55:00Z", asOf, ledger, history),
    "VALID",
  );
  assert.equal(
    validateData(
      prices,
      observedAt,
      asOf,
      { ...ledger, cashCents: -1 },
      history,
    ),
    "INVALID",
  );
  assert.equal(
    validateData(
      prices,
      observedAt,
      asOf,
      { ...ledger, units: { ...ledger.units, TRES: 1.5 } },
      history,
    ),
    "INVALID",
  );
  assert.equal(
    validateData(prices, observedAt, asOf, ledger, {
      ...history,
      TRES: history.TRES.slice(1),
    }),
    "INVALID",
  );
  assert.equal(
    validateData(prices, observedAt, asOf, ledger, {
      ...history,
      PROP: [1, 2, 3],
    }),
    "INVALID",
  );
  assert.equal(
    validateData(prices, observedAt, asOf, ledger, {
      ...history,
      PROP: [...history.PROP.slice(0, -1), 1],
    }),
    "INVALID",
  );
  assert.equal(
    validateData(
      prices,
      observedAt,
      asOf,
      { cashCents: 0, units: { TRES: 0, PROP: 0 } },
      history,
    ),
    "INVALID",
  );
});

test("invalid action, insufficient quorum and broker failure stop at distinct gates", () => {
  const invalid = runPaper("invalid-action");
  assert.equal(invalid.consensus!.status, "APPROVED");
  assert.equal(
    invalid.audit.find((e) => e.stage === "CONSTRAINTS")!.status,
    "DENIED",
  );
  assert.match(invalid.reasons.join(" "), /Insufficient units/);
  const escalated = runPaper("insufficient-consensus");
  assert.equal(escalated.consensus!.support, 0.4);
  assert.equal(escalated.consensus!.status, "ESCALATED");
  assert.equal(
    escalated.audit.some((e) => e.stage === "CONSTRAINTS"),
    false,
  );
  const failed = runPaper("execution-failure");
  assert.equal(
    failed.audit.find((e) => e.stage === "CONSTRAINTS")!.status,
    "APPROVED",
  );
  assert.equal(
    failed.audit.find((e) => e.stage === "EXECUTION")!.status,
    "FAILED",
  );
  assert.match(failed.reasons.join(" "), /no funds moved/);
});

test("duplicate votes alone cannot manufacture quorum; unknown voters and other actions have no influence", () => {
  const action = runPaper().action!;
  const repeated = Array.from({ length: 25 }, () => vote(action, "risk"));
  const result = consensus(action, [
    ...repeated,
    vote(action, "intruder"),
    { ...vote(action, "liquidity"), actionId: "different" },
  ]);
  assert.equal(result.support, 0.4);
  assert.equal(result.status, "ESCALATED");
  assert.equal(result.duplicateVotesIgnored, 24);
  assert.equal(result.votes.length, 1);
  const scenario = runPaper("duplicate-vote");
  assert.equal(scenario.consensus!.duplicateVotesIgnored, 8);
  assert.equal(scenario.consensus!.support, 1);
  assert.equal(scenario.consensus!.votes.length, 3);
});

test("compliance veto and contradictory duplicate votes fail closed", () => {
  const action = runPaper().action!;
  const result = consensus(action, [
    vote(action, "risk"),
    vote(action, "liquidity"),
    vote(action, "compliance", "OPPOSE"),
  ]);
  assert.equal(result.support, 0.75);
  assert.equal(result.status, "DENIED");
  const conflict = consensus(action, [
    vote(action, "risk"),
    vote(action, "risk", "ABSTAIN"),
    vote(action, "risk"),
    vote(action, "liquidity"),
  ]);
  assert.equal(conflict.support, 0.35);
  assert.equal(conflict.opposition, 0.4);
  assert.equal(conflict.status, "ESCALATED");
});

test("broker retries are idempotent, conflicting keys are rejected and snapshots are isolated", () => {
  const run = runPaper();
  const broker = new PaperBroker(run.before);
  const first = broker.execute(run.action!, run.pricesCents);
  const after = broker.snapshot();
  assert.deepEqual(
    broker.execute(structuredClone(run.action!), { ...run.pricesCents }),
    first,
  );
  assert.deepEqual(broker.snapshot(), after);
  assert.throws(
    () =>
      broker.execute(
        { ...run.action!, units: run.action!.units - 1 },
        run.pricesCents,
      ),
    /Conflicting idempotency key/,
  );
  assert.throws(
    () => broker.execute(run.action!, { ...run.pricesCents, TRES: 10121 }),
    /Conflicting idempotency key/,
  );
  assert.deepEqual(broker.snapshot(), after);
  first.feeCents = 0;
  after.cashCents = 0;
  assert.equal(broker.execute(run.action!, run.pricesCents).feeCents, 6373);
  assert.equal(broker.snapshot().cashCents, 22741076);
});

test("broker rejection is atomic and does not consume a successful-fill idempotency key", () => {
  const run = runPaper();
  const broker = new PaperBroker(run.before);
  assert.throws(
    () => broker.execute(run.action!, run.pricesCents, true),
    /rejected/,
  );
  assert.deepEqual(broker.snapshot(), run.before);
  assert.deepEqual(broker.execute(run.action!, run.pricesCents), run.fills[0]);
  assert.deepEqual(broker.snapshot(), run.after);
});

test("independent constraints reject malformed, oversized and unsatisfied sell actions", () => {
  const run = runPaper();
  for (const action of [
    { ...run.action!, type: "BUY" },
    { ...run.action!, actionId: "invented" },
    { ...run.action!, assetId: "UNKNOWN" },
    { ...run.action!, units: 0 },
    { ...run.action!, units: 1.5 },
    { ...run.action!, units: NaN },
    { ...run.action!, units: "1261" },
    { ...run.action!, units: 7001 },
    { ...run.action!, units: 2100 },
    { ...run.action!, limitPriceCents: 10120 },
    { ...run.action!, units: 1 },
  ]) {
    assert.ok(
      checkAction(action as PaperAction, run.before, run.pricesCents).length >
        0,
      JSON.stringify(action),
    );
  }
  assert.deepEqual(checkAction(run.action!, run.before, run.pricesCents), []);
});

test("money helpers reject unsafe integers, negative holdings and overflow", () => {
  for (const value of [NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => integer(value, "test"));
  assert.throws(
    () =>
      equity(
        { cashCents: Number.MAX_SAFE_INTEGER, units: { TRES: 1 } },
        { TRES: 1 },
      ),
    /overflow/,
  );
  assert.throws(
    () => equity({ cashCents: 0, units: { TRES: -1 } }, { TRES: 1 }),
    /safe integer/,
  );
  assert.throws(
    () =>
      risk({ cashCents: 0, units: { TRES: 0, PROP: 0 } }, FIXTURE.pricesCents),
    /nonpositive NAV/,
  );
});

test("audit detects changed content, sequence, head, rehashed semantic forgery and truncation", () => {
  const run = runPaper();
  const changed = structuredClone(run.audit);
  changed[0].message = "forged";
  assert.throws(() => replayAudit(changed), /hash\/sequence/);
  assert.throws(() => replayAudit(run.audit, "f".repeat(64)), /trusted anchor/);
  const forged = structuredClone(run.audit);
  (
    forged.find((e) => e.stage === "EXECUTION")!.payload.fill as {
      feeCents: number;
    }
  ).feeCents = 0;
  const rechained = rehash(forged);
  assert.throws(
    () => replayAudit(rechained, rechained.at(-1)!.hash),
    /Semantic replay mismatch/,
  );
  assert.throws(
    () => replayAudit(run.audit.slice(0, -1)),
    /Semantic replay mismatch/,
  );
  assert.throws(
    () =>
      replayAudit(
        rehash([
          run.audit[0],
          run.audit[2],
          run.audit[1],
          ...run.audit.slice(3),
        ]),
      ),
    /Semantic replay mismatch/,
  );
  const unknown = structuredClone(run.audit);
  unknown[0].payload.datasetHash = "f".repeat(64);
  assert.throws(() => replayAudit(rehash(unknown)), /Unknown dataset/);
  for (const invalid of [
    null,
    {},
    [],
    [run.audit[0]],
    Array(101).fill(run.audit[0]),
  ])
    assert.throws(() => replayAudit(invalid), /audit stream/);
});

test("canonical hashes ignore object insertion order but preserve exact data and reject unsupported numbers", () => {
  assert.equal(
    digest({ b: 2, a: { d: 4, c: 3 } }),
    digest({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assert.notEqual(digest({ price: 10120 }), digest({ price: "10120" }));
  assert.throws(() => canonical({ value: NaN }), /Non-finite/);
  assert.throws(() => canonical({ value: undefined }), /Unsupported/);
  assert.throws(() => runPaper("LIVE" as PaperScenarioId), /Unknown scenario/);
});
