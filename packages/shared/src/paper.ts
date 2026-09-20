export const PAPER_SCENARIOS = [
  {
    id: "normal",
    title: "Normal rebalance",
    description: "Trim concentration, apply costs, and reconcile a paper fill.",
  },
  {
    id: "missing-price",
    title: "Missing price",
    description: "Missing valuation blocks the run; risk remains unknown.",
  },
  {
    id: "stale-price",
    title: "Stale price",
    description: "An expired quote cannot authorize a trade.",
  },
  {
    id: "invalid-action",
    title: "Invalid trade size",
    description: "Independent constraints reject an oversized proposal.",
  },
  {
    id: "insufficient-consensus",
    title: "Insufficient consensus",
    description: "Abstentions keep the action awaiting human review.",
  },
  {
    id: "execution-failure",
    title: "Execution failure",
    description: "A rejected paper fill leaves the ledger unchanged.",
  },
  {
    id: "duplicate-vote",
    title: "Duplicate vote",
    description: "Repeated votes do not increase an agent's voting power.",
  },
] as const;

export type PaperScenarioId = (typeof PAPER_SCENARIOS)[number]["id"];
export type PaperStatus =
  "CONFIRMED" | "BLOCKED" | "ESCALATED" | "FAILED" | "NO_ACTION";
export type PaperStage =
  | "DATA"
  | "RISK"
  | "PROPOSAL"
  | "CONSENSUS"
  | "CONSTRAINTS"
  | "EXECUTION"
  | "RECONCILIATION";
export type PaperLedger = { cashCents: number; units: Record<string, number> };
export type PaperRisk = {
  concentration: number;
  historicalVar95Pct: number;
  historicalEs95Pct: number;
  maxDrawdownPct: number;
  samples: number;
  method: "historical-simulation";
  source: "synthetic-fixture";
};
export type PaperAction = {
  actionId: string;
  type: "SELL";
  assetId: string;
  units: number;
  limitPriceCents: number;
};
export type PaperVote = {
  actionId: string;
  agentId: string;
  stance: "SUPPORT" | "OPPOSE" | "ABSTAIN";
  reason: string;
};
export type PaperConsensus = {
  threshold: number;
  support: number;
  opposition: number;
  duplicateVotesIgnored: number;
  status: "APPROVED" | "DENIED" | "ESCALATED";
  votes: PaperVote[];
};
export type PaperFill = {
  fillId: string;
  actionId: string;
  assetId: string;
  units: number;
  priceCents: number;
  grossCents: number;
  feeCents: number;
  slippageCostCents: number;
  mode: "PAPER";
};
export type PaperAuditEvent = {
  sequence: number;
  runId: string;
  tickId: string;
  at: string;
  stage: PaperStage;
  status: string;
  message: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
};
export type PaperRun = {
  schemaVersion: 1;
  runId: string;
  tickId: string;
  scenario: PaperScenarioId;
  mode: "PAPER";
  datasetId: string;
  datasetHash: string;
  policyHash: string;
  asOf: string;
  status: PaperStatus;
  reasons: string[];
  dataQuality: "VALID" | "MISSING" | "STALE" | "INVALID";
  pricesCents: Record<string, number>;
  assetNames: Record<string, string>;
  before: PaperLedger;
  after: PaperLedger;
  equityBeforeCents: number | null;
  equityAfterCents: number | null;
  riskBefore: PaperRisk | null;
  riskAfter: PaperRisk | null;
  action: PaperAction | null;
  consensus: PaperConsensus | null;
  fills: PaperFill[];
  audit: PaperAuditEvent[];
  auditHead: string;
  reconciliation: {
    ok: boolean;
    cashDeltaCents: number;
    equityChangeCents: number | null;
    expectedCostCents: number;
    unitsConserved: boolean;
  };
};

export type PaperApiState = {
  ok: true;
  mode: "PAPER";
  liveExecutionEnabled: false;
  run: PaperRun;
};
