import type { PaperApiState, PaperRun, PaperStage } from "@rpm/shared";

export function formatMoney(cents: number | null | undefined): string {
  return cents == null || !Number.isFinite(cents) ? "UNKNOWN" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function formatPercent(value: number | null | undefined, fraction = false): string {
  return value == null || !Number.isFinite(value) ? "UNKNOWN" : `${(value * (fraction ? 100 : 1)).toFixed(2)}%`;
}

export function statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (["CONFIRMED", "APPROVED", "PASS", "PASSED", "VALID", "SUPPORT", "FILLED", "OK", "COMPLETED"].includes(status)) return "good";
  if (["FAILED", "BLOCKED", "DENIED", "MISSING", "STALE", "INVALID", "OPPOSE", "REJECTED"].includes(status)) return "bad";
  if (["ESCALATED", "UNKNOWN", "ABSTAIN"].includes(status)) return "warn";
  return "neutral";
}

export function stageResult(run: Pick<PaperRun, "audit">, stage: PaperStage): string {
  return [...run.audit].reverse().find((event) => event.stage === stage)?.status ?? "NOT_REACHED";
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const safeInteger = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const numberRecord = (value: unknown): boolean => object(value) && Object.values(value).every(safeInteger);
const nullableMoney = (value: unknown): boolean => value === null || safeInteger(value);
const ledger = (value: unknown): boolean => object(value) && safeInteger(value.cashCents) && numberRecord(value.units);
const risk = (value: unknown): boolean => value === null || (object(value) && ["concentration", "historicalVar95Pct", "historicalEs95Pct", "maxDrawdownPct", "samples"].every((key) => finite(value[key])) && value.source === "synthetic-fixture" && value.method === "historical-simulation");

/** Reject an incompatible/live response before displaying any result as a paper replay. */
export function parsePaperState(value: unknown): PaperApiState {
  const invalid = () => { throw new Error("The service returned an incompatible paper replay. No new result was displayed."); };
  if (!object(value) || value.ok !== true || value.mode !== "PAPER" || value.liveExecutionEnabled !== false || !object(value.run)) return invalid();
  const run = value.run;
  if (run.schemaVersion !== 1 || run.mode !== "PAPER" || !["normal", "missing-price", "stale-price", "invalid-action", "insufficient-consensus", "execution-failure", "duplicate-vote"].includes(String(run.scenario)) || !["CONFIRMED", "BLOCKED", "ESCALATED", "FAILED", "NO_ACTION"].includes(String(run.status))) return invalid();
  if (!["VALID", "MISSING", "STALE", "INVALID"].includes(String(run.dataQuality)) || !["runId", "tickId", "datasetId", "datasetHash", "policyHash", "asOf", "auditHead"].every((key) => typeof run[key] === "string") || !Number.isFinite(Date.parse(String(run.asOf)))) return invalid();
  if (!strings(run.reasons) || !ledger(run.before) || !ledger(run.after) || !numberRecord(run.pricesCents) || !object(run.assetNames) || !Object.values(run.assetNames).every((name) => typeof name === "string") || !nullableMoney(run.equityBeforeCents) || !nullableMoney(run.equityAfterCents) || !risk(run.riskBefore) || !risk(run.riskAfter)) return invalid();
  if (run.action !== null && (!object(run.action) || run.action.type !== "SELL" || !["actionId", "assetId"].every((key) => typeof (run.action as RecordValue)[key] === "string") || !safeInteger(run.action.units) || !safeInteger(run.action.limitPriceCents))) return invalid();
  if (run.consensus !== null && (!object(run.consensus) || !["APPROVED", "DENIED", "ESCALATED"].includes(String(run.consensus.status)) || !["threshold", "support", "opposition", "duplicateVotesIgnored"].every((key) => finite((run.consensus as RecordValue)[key])) || !Array.isArray(run.consensus.votes) || !run.consensus.votes.every((vote) => object(vote) && ["actionId", "agentId", "reason"].every((key) => typeof vote[key] === "string") && ["SUPPORT", "OPPOSE", "ABSTAIN"].includes(String(vote.stance))))) return invalid();
  if (!Array.isArray(run.fills) || !run.fills.every((fill) => object(fill) && fill.mode === "PAPER" && ["fillId", "actionId", "assetId"].every((key) => typeof fill[key] === "string") && ["units", "priceCents", "grossCents", "feeCents", "slippageCostCents"].every((key) => safeInteger(fill[key])))) return invalid();
  if (!Array.isArray(run.audit) || !run.audit.every((event) => object(event) && safeInteger(event.sequence) && ["runId", "tickId", "at", "status", "message", "previousHash", "hash"].every((key) => typeof event[key] === "string") && ["DATA", "RISK", "PROPOSAL", "CONSENSUS", "CONSTRAINTS", "EXECUTION", "RECONCILIATION"].includes(String(event.stage)) && object(event.payload))) return invalid();
  if (!object(run.reconciliation) || typeof run.reconciliation.ok !== "boolean" || typeof run.reconciliation.unitsConserved !== "boolean" || !safeInteger(run.reconciliation.cashDeltaCents) || !safeInteger(run.reconciliation.expectedCostCents) || !nullableMoney(run.reconciliation.equityChangeCents)) return invalid();
  return value as PaperApiState;
}
