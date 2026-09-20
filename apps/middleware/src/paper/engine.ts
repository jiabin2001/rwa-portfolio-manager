import { createHash } from "node:crypto";
import {
  PAPER_SCENARIOS,
  type PaperAction,
  type PaperAuditEvent,
  type PaperConsensus,
  type PaperFill,
  type PaperLedger,
  type PaperRisk,
  type PaperRun,
  type PaperScenarioId,
  type PaperVote,
} from "@rpm/shared";
import { FIXTURE, PAPER_POLICY } from "./fixture.js";

/** Sorted-key encoding is part of schema v1; floating risk values are not ledger money. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Non-finite JSON number");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Unsupported JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const DATASET_HASH = digest(FIXTURE);
export const POLICY_HASH = digest(PAPER_POLICY);
const ZERO_HASH = "0".repeat(64);
export function integer(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${label} must be a safe integer >= ${min}`);
  return value;
}
function safeBig(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Ledger integer overflow");
  return n;
}
export function equity(
  ledger: PaperLedger,
  prices: Record<string, number>,
): number {
  let total = BigInt(integer(ledger.cashCents, "cash"));
  for (const [asset, units] of Object.entries(ledger.units))
    total +=
      BigInt(integer(units, "units")) *
      BigInt(integer(prices[asset], `price ${asset}`, 1));
  return safeBig(total);
}
export function validateData(
  prices: Record<string, number>,
  observedAt: string,
  asOf: string,
  ledger: PaperLedger,
  history: Record<string, readonly number[]>,
): PaperRun["dataQuality"] {
  const age = (Date.parse(asOf) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return "INVALID";
  if (age > PAPER_POLICY.maxQuoteAgeSeconds) return "STALE";
  if (Object.keys(ledger.units).some((asset) => !(asset in prices)))
    return "MISSING";
  try {
    if (equity(ledger, prices) <= 0) return "INVALID";
    const lengths = Object.keys(ledger.units).map((asset) => {
      integer(prices[asset], "price", 1);
      const points = history[asset];
      if (!points || points.length < 20 || points.at(-1) !== prices[asset])
        throw new Error("Invalid history");
      points.forEach((p) => integer(p, "historical price", 1));
      return points.length;
    });
    if (new Set(lengths).size !== 1) return "INVALID";
  } catch {
    return "INVALID";
  }
  return "VALID";
}
/** Current fixed holdings repriced over the fixture history, cash included; not a strategy backtest. */
export function risk(
  ledger: PaperLedger,
  prices: Record<string, number>,
  history: Record<string, readonly number[]> = FIXTURE.historyCents,
): PaperRisk {
  const nav = equity(ledger, prices);
  if (nav <= 0) throw new Error("Risk unavailable for nonpositive NAV");
  const assets = Object.keys(ledger.units);
  const n = history[assets[0]]?.length ?? 0;
  if (n < 20 || assets.some((a) => history[a]?.length !== n))
    throw new Error("Insufficient aligned history");
  const values = Array.from({ length: n }, (_, i) =>
    equity(ledger, Object.fromEntries(assets.map((a) => [a, history[a][i]]))),
  );
  const losses = values
    .slice(1)
    .map((v, i) => -(v / values[i] - 1))
    .sort((a, b) => a - b);
  const quantile = losses[Math.ceil(0.95 * losses.length) - 1];
  const tail = losses.filter((v) => v >= quantile);
  let peak = values[0],
    drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, 1 - value / peak);
  }
  return {
    concentration: Math.max(
      ...assets.map((a) => (ledger.units[a] * prices[a]) / nav),
    ),
    historicalVar95Pct: Math.max(0, quantile) * 100,
    historicalEs95Pct:
      Math.max(0, tail.reduce((s, v) => s + v, 0) / tail.length) * 100,
    maxDrawdownPct: drawdown * 100,
    samples: losses.length,
    method: "historical-simulation",
    source: "synthetic-fixture",
  };
}
export function consensus(
  action: PaperAction,
  votes: PaperVote[],
): PaperConsensus {
  const weights: Record<string, number> = PAPER_POLICY.weights;
  const eligible = votes.filter(
    (v) => v.actionId === action.actionId && Object.hasOwn(weights, v.agentId),
  );
  const byAgent = new Map<string, PaperVote>();
  let duplicateVotesIgnored = 0;
  for (const v of eligible) {
    if (!["SUPPORT", "OPPOSE", "ABSTAIN"].includes(v.stance))
      throw new Error("Invalid vote stance");
    const previous = byAgent.get(v.agentId);
    if (previous) {
      duplicateVotesIgnored++;
      if (previous.stance !== v.stance)
        byAgent.set(v.agentId, {
          ...v,
          stance: "OPPOSE",
          reason: "Conflicting repeated votes: fail closed",
        });
    } else byAgent.set(v.agentId, { ...v });
  }
  const unique = [...byAgent.values()].sort((a, b) =>
    a.agentId.localeCompare(b.agentId, "en"),
  );
  const sum = (stance: PaperVote["stance"]) =>
    unique
      .filter((v) => v.stance === stance)
      .reduce((s, v) => s + weights[v.agentId], 0);
  const support = sum("SUPPORT"),
    opposition = sum("OPPOSE");
  const veto = unique.some(
    (v) => v.agentId === "compliance" && v.stance === "OPPOSE",
  );
  return {
    threshold: PAPER_POLICY.threshold,
    support,
    opposition,
    duplicateVotesIgnored,
    status:
      veto || opposition >= PAPER_POLICY.threshold
        ? "DENIED"
        : support >= PAPER_POLICY.threshold
          ? "APPROVED"
          : "ESCALATED",
    votes: unique,
  };
}
/** Execution never trusts agent-supplied constraint assertions. */
export function checkAction(
  action: PaperAction,
  ledger: PaperLedger,
  prices: Record<string, number>,
): string[] {
  try {
    if (
      !action ||
      action.type !== "SELL" ||
      typeof action.actionId !== "string" ||
      !/^[a-f0-9]{64}$/.test(action.actionId)
    )
      throw new Error("Unsupported action or identity");
    if (
      !Object.hasOwn(ledger.units, action.assetId) ||
      !Object.hasOwn(prices, action.assetId)
    )
      throw new Error("Unknown asset");
    integer(action.units, "sell units", 1);
    integer(action.limitPriceCents, "limit price", 1);
    const price = integer(prices[action.assetId], "price", 1);
    if (action.units > ledger.units[action.assetId])
      throw new Error("Insufficient units");
    const notional = safeBig(BigInt(action.units) * BigInt(price));
    if (notional / equity(ledger, prices) > PAPER_POLICY.maxTurnover)
      throw new Error("Turnover limit exceeded");
    const fill = calculateFill(action, price);
    if (fill.priceCents < action.limitPriceCents)
      throw new Error("Limit price cannot be satisfied");
    const next = applyFill(ledger, fill);
    if (risk(next, prices).concentration > PAPER_POLICY.maxConcentration)
      throw new Error("Post-trade concentration limit exceeded");
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : "Invalid action"];
  }
}
export function calculateFill(action: PaperAction, mid: number): PaperFill {
  integer(mid, "mid", 1);
  integer(action.units, "units", 1);
  const priceCents = safeBig(
    (BigInt(mid) * BigInt(10000 - PAPER_POLICY.slippageBps)) / 10000n,
  );
  const grossCents = safeBig(BigInt(action.units) * BigInt(priceCents));
  return {
    fillId: digest({ actionId: action.actionId, mode: "PAPER" }),
    actionId: action.actionId,
    assetId: action.assetId,
    units: action.units,
    priceCents,
    grossCents,
    feeCents: safeBig(
      (BigInt(grossCents) * BigInt(PAPER_POLICY.feeBps)) / 10000n,
    ),
    slippageCostCents: safeBig(BigInt(action.units) * BigInt(mid - priceCents)),
    mode: "PAPER",
  };
}
function applyFill(before: PaperLedger, fill: PaperFill): PaperLedger {
  const next = structuredClone(before);
  next.units[fill.assetId] = integer(
    next.units[fill.assetId] - fill.units,
    "remaining units",
  );
  next.cashCents = integer(
    safeBig(
      BigInt(next.cashCents) + BigInt(fill.grossCents) - BigInt(fill.feeCents),
    ),
    "cash",
  );
  return next;
}
/** Run-scoped ledger. A fill is atomic; same id + same payload is idempotent, conflicting reuse fails. */
export class PaperBroker {
  private ledger: PaperLedger;
  private completed = new Map<
    string,
    { fingerprint: string; fill: PaperFill }
  >();
  constructor(initial: PaperLedger) {
    this.ledger = structuredClone(initial);
  }
  snapshot() {
    return structuredClone(this.ledger);
  }
  execute(
    action: PaperAction,
    prices: Record<string, number>,
    reject = false,
  ): PaperFill {
    const fingerprint = digest({ action, prices });
    const prior = this.completed.get(action.actionId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("Conflicting idempotency key");
      return structuredClone(prior.fill);
    }
    const errors = checkAction(action, this.ledger, prices);
    if (errors.length) throw new Error(errors.join("; "));
    if (reject)
      throw new Error(
        "Paper broker rejected the fill (injected failure); no funds moved",
      );
    const fill = calculateFill(action, prices[action.assetId]);
    const next = applyFill(this.ledger, fill);
    this.completed.set(action.actionId, { fingerprint, fill });
    this.ledger = next;
    return structuredClone(fill);
  }
}
export function isScenario(value: unknown): value is PaperScenarioId {
  return PAPER_SCENARIOS.some((s) => s.id === value);
}

export function runPaper(scenario: PaperScenarioId = "normal"): PaperRun {
  if (!isScenario(scenario)) throw new Error("Unknown scenario");
  const runId = digest({
    schemaVersion: 1,
    datasetHash: DATASET_HASH,
    policyHash: POLICY_HASH,
    scenario,
  });
  const tickId = `tick-${runId.slice(0, 16)}`;
  const before: PaperLedger = structuredClone(FIXTURE.initialLedger);
  const prices: Record<string, number> = { ...FIXTURE.pricesCents };
  if (scenario === "missing-price") delete prices.PROP;
  const observedAt =
    scenario === "stale-price"
      ? "2026-01-30T16:00:00.000Z"
      : FIXTURE.observedAt;
  const dataQuality = validateData(
    prices,
    observedAt,
    FIXTURE.asOf,
    before,
    FIXTURE.historyCents,
  );
  const run: PaperRun = {
    schemaVersion: 1,
    runId,
    tickId,
    scenario,
    mode: "PAPER",
    datasetId: FIXTURE.datasetId,
    datasetHash: DATASET_HASH,
    policyHash: POLICY_HASH,
    asOf: FIXTURE.asOf,
    status: "BLOCKED",
    reasons: [],
    dataQuality,
    pricesCents: prices,
    assetNames: { ...FIXTURE.assetNames },
    before,
    after: structuredClone(before),
    equityBeforeCents: null,
    equityAfterCents: null,
    riskBefore: null,
    riskAfter: null,
    action: null,
    consensus: null,
    fills: [],
    audit: [],
    auditHead: ZERO_HASH,
    reconciliation: {
      ok: true,
      cashDeltaCents: 0,
      equityChangeCents: null,
      expectedCostCents: 0,
      unitsConserved: true,
    },
  };
  const record = (
    stage: PaperAuditEvent["stage"],
    status: string,
    message: string,
    payload: Record<string, unknown>,
  ) => {
    const entry = {
      sequence: run.audit.length + 1,
      runId,
      tickId,
      at: FIXTURE.asOf,
      stage,
      status,
      message,
      payload: structuredClone(payload),
      previousHash: run.auditHead,
    };
    const hash = digest(entry);
    run.audit.push({ ...entry, hash });
    run.auditHead = hash;
  };
  record("DATA", dataQuality, "Versioned synthetic fixture loaded", {
    schemaVersion: 1,
    datasetId: FIXTURE.datasetId,
    datasetHash: DATASET_HASH,
    policyHash: POLICY_HASH,
    scenario,
    observedAt,
    asOf: FIXTURE.asOf,
    pricesCents: prices,
    before,
  });
  if (dataQuality !== "VALID") {
    run.reasons.push(
      `${dataQuality} data: valuation and risk are UNKNOWN; execution blocked`,
    );
    record("RISK", "UNKNOWN", run.reasons[0], { risk: null });
  } else {
    run.equityBeforeCents = equity(before, prices);
    run.riskBefore = risk(before, prices);
    record(
      "RISK",
      "CALCULATED",
      "Historical fixed-holdings risk; synthetic, not a backtest",
      { risk: run.riskBefore, equityCents: run.equityBeforeCents },
    );
    const assetId = Object.keys(before.units).sort(
      (a, b) => before.units[b] * prices[b] - before.units[a] * prices[a],
    )[0];
    const size = Math.max(
      0,
      Math.ceil(
        (before.units[assetId] * prices[assetId] -
          PAPER_POLICY.targetConcentration * run.equityBeforeCents) /
          prices[assetId],
      ),
    );
    if (
      run.riskBefore.concentration <= PAPER_POLICY.maxConcentration ||
      size === 0
    ) {
      run.status = "NO_ACTION";
      run.reasons.push("Portfolio is within concentration limits");
      record("PROPOSAL", "NO_ACTION", run.reasons[0], {});
    } else {
      const terms = {
        type: "SELL" as const,
        assetId,
        units: scenario === "invalid-action" ? before.units[assetId] + 1 : size,
        limitPriceCents: Math.floor(
          (prices[assetId] * (10000 - 2 * PAPER_POLICY.slippageBps)) / 10000,
        ),
      };
      const action: PaperAction = {
        ...terms,
        actionId: digest({ runId, ...terms }),
      };
      run.action = action;
      record(
        "PROPOSAL",
        "PROPOSED",
        "Trim largest asset to the 58% target, subject to independent gates",
        { action },
      );
      const votes: PaperVote[] = Object.keys(PAPER_POLICY.weights).map(
        (agentId) => ({
          actionId: action.actionId,
          agentId,
          stance:
            scenario === "insufficient-consensus" && agentId !== "risk"
              ? "ABSTAIN"
              : "SUPPORT",
          reason:
            agentId === "risk"
              ? "Concentration breach identified"
              : agentId === "liquidity"
                ? "Synthetic fixture permits selling; no market-liquidity claim"
                : "Asset is in the fixture allowlist",
        }),
      );
      if (scenario === "duplicate-vote")
        votes.push(...Array.from({ length: 8 }, () => ({ ...votes[0] })));
      run.consensus = consensus(action, votes);
      record(
        "CONSENSUS",
        run.consensus.status,
        "One eligible vote per agent and action; abstentions retain denominator weight",
        { consensus: run.consensus },
      );
      if (run.consensus.status !== "APPROVED") {
        run.status =
          run.consensus.status === "ESCALATED" ? "ESCALATED" : "BLOCKED";
        run.reasons.push(
          "Consensus is not approved; manual review required; no automatic override",
        );
      } else {
        const errors = checkAction(action, before, prices);
        record(
          "CONSTRAINTS",
          errors.length ? "DENIED" : "APPROVED",
          "Independent size, holdings, turnover, limit-price and post-trade concentration checks",
          { errors, actionId: action.actionId },
        );
        if (errors.length) {
          run.status = "BLOCKED";
          run.reasons.push(...errors);
        } else {
          const broker = new PaperBroker(before);
          try {
            const fill = broker.execute(
              action,
              prices,
              scenario === "execution-failure",
            );
            run.fills.push(fill);
            run.after = broker.snapshot();
            run.status = "CONFIRMED";
            run.reasons.push(
              "Paper fill confirmed; fees and slippage charged; ledger reconciled",
            );
            record(
              "EXECUTION",
              "CONFIRMED",
              "Paper fill only: no blockchain transaction was submitted",
              { fill, after: run.after },
            );
          } catch (e) {
            run.status = "FAILED";
            run.after = broker.snapshot();
            run.reasons.push(
              e instanceof Error ? e.message : "Execution failed",
            );
            record("EXECUTION", "FAILED", run.reasons.at(-1)!, {
              after: run.after,
              actionId: action.actionId,
            });
          }
        }
      }
    }
    run.equityAfterCents = equity(run.after, prices);
    run.riskAfter = risk(run.after, prices);
  }
  const cashDeltaCents = run.after.cashCents - run.before.cashCents;
  const expectedCash = run.fills.reduce(
    (s, f) => s + f.grossCents - f.feeCents,
    0,
  );
  const expectedCostCents = run.fills.reduce(
    (s, f) => s + f.feeCents + f.slippageCostCents,
    0,
  );
  const equityChangeCents =
    run.equityAfterCents === null || run.equityBeforeCents === null
      ? null
      : run.equityAfterCents - run.equityBeforeCents;
  const unitsConserved = Object.keys(before.units).every(
    (asset) =>
      run.after.units[asset] ===
      before.units[asset] -
        run.fills
          .filter((f) => f.assetId === asset)
          .reduce((s, f) => s + f.units, 0),
  );
  const ok =
    cashDeltaCents === expectedCash &&
    unitsConserved &&
    (equityChangeCents === null
      ? run.fills.length === 0
      : equityChangeCents === -expectedCostCents);
  run.reconciliation = {
    ok,
    cashDeltaCents,
    equityChangeCents,
    expectedCostCents,
    unitsConserved,
  };
  if (!ok)
    throw new Error(
      "Internal reconciliation failed; refusing to publish a result",
    );
  record(
    "RECONCILIATION",
    "PASS",
    "Units and cash match fills; NAV loss equals explicit costs when valuation is available",
    {
      status: run.status,
      reasons: run.reasons,
      after: run.after,
      riskAfter: run.riskAfter,
      equityAfterCents: run.equityAfterCents,
      reconciliation: run.reconciliation,
    },
  );
  return run;
}

/** Hash verification + semantic re-execution against the trusted, versioned local fixture/policy. */
export function replayAudit(events: unknown, expectedHead?: string): PaperRun {
  if (!Array.isArray(events) || events.length < 2 || events.length > 100)
    throw new Error("Invalid or incomplete audit stream");
  let head = ZERO_HASH;
  for (const [i, event] of events.entries()) {
    if (!event || typeof event !== "object")
      throw new Error("Invalid audit event");
    const { hash, ...body } = event as PaperAuditEvent;
    if (
      body.sequence !== i + 1 ||
      body.previousHash !== head ||
      digest(body) !== hash
    )
      throw new Error(`Audit hash/sequence mismatch at event ${i + 1}`);
    head = hash;
  }
  if (expectedHead && head !== expectedHead)
    throw new Error("Audit head does not match trusted anchor");
  const first = events[0] as PaperAuditEvent;
  if (
    first.payload.datasetHash !== DATASET_HASH ||
    first.payload.policyHash !== POLICY_HASH ||
    !isScenario(first.payload.scenario)
  )
    throw new Error("Unknown dataset, policy or scenario");
  const replayed = runPaper(first.payload.scenario);
  if (canonical(replayed.audit) !== canonical(events))
    throw new Error(
      "Semantic replay mismatch (altered, reordered, or truncated result)",
    );
  return replayed;
}
