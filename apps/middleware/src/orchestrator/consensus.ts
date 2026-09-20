import { ConsensusRule, Decision, Signal, ActionIntent, ActionConsensus, ConsensusSummary } from "@rpm/shared";
import { randomUUID as uuidv4 } from "node:crypto";

export type OrchestratorConfig = {
  // agent weights (0..1), should sum <= 1.0
  weights: Record<string, number>;
  rule: ConsensusRule;
};

function stableStringify(obj: unknown): string {
  if (obj == null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function actionKey(intent: ActionIntent): string {
  return `${intent.type}|${stableStringify(intent.params)}|${stableStringify(intent.route ?? {})}`;
}

export function aggregateSignals(signals: Signal[], rule?: ConsensusRule): { vetoed: boolean; actions: ActionIntent[]; rationale: string } {
  const veto = signals.some(s => s.veto === true && (!rule?.vetoAgents || rule.vetoAgents.includes(s.agent)));
  const actions = signals.flatMap(s => s.recommendations ?? []);
  const rationale = signals.map(s => `- [${s.agent}] ${s.summary}`).join("\n");
  return { vetoed: veto, actions, rationale };
}

export function decide(
  cfg: OrchestratorConfig,
  signals: Signal[],
  riskScore: number,
  effectiveWeights?: Record<string, number>
): Decision {
  const { vetoed, rationale } = aggregateSignals(signals, cfg.rule);
  const weights = effectiveWeights ?? cfg.weights;
  if (!Number.isFinite(cfg.rule.thresholdWeight) || cfg.rule.thresholdWeight <= 0 || cfg.rule.thresholdWeight > 1 ||
      Object.values(weights).some(weight => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("Consensus weights and threshold must be finite and non-negative; threshold must be in (0, 1].");
  }
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new Error("Consensus requires positive electorate weight.");
  const thresholdWeight = cfg.rule.thresholdWeight * totalWeight;
  const vetoAgents = [...new Set(signals
    .filter(s => s.veto && (!cfg.rule.vetoAgents || cfg.rule.vetoAgents.includes(s.agent)))
    .map(s => s.agent))];
  const opposeAgents = [...new Set(signals.filter(s => s.stance === "OPPOSE").map(s => s.agent))];
  const confidence = (s: Signal) => Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1 ? s.confidence : 0;
  const opposeWeight = opposeAgents.reduce((acc, agent) => acc + (weights[agent] ?? 0) *
    Math.max(0, ...signals.filter(s => s.agent === agent && s.stance === "OPPOSE").map(confidence)), 0);

  const byKey = new Map<string, ActionConsensus>();
  const votes = new Map<string, Map<string, number>>();
  for (const s of signals) {
    const agentWeight = weights[s.agent] ?? 0;
    // Recommendations are proposals, not votes. Only an explicit SUPPORT
    // stance counts; contradictory OPPOSE reports fail closed for that agent.
    const influence = s.stance === "SUPPORT" && !opposeAgents.includes(s.agent) ? agentWeight * confidence(s) : 0;
    for (const intent of s.recommendations ?? []) {
      const key = actionKey(intent);
      if (!byKey.has(key)) {
        byKey.set(key, {
          intent,
          supportWeight: 0,
          opposeWeight: 0,
          supportAgents: [],
          opposeAgents: [],
          status: "ESCALATE",
          reasons: [...(s.reasons ?? [])],
        });
        votes.set(key, new Map());
      }
      // Repeating an intent or repeating a signal never creates another vote.
      const agentVotes = votes.get(key)!;
      agentVotes.set(s.agent, Math.max(agentVotes.get(s.agent) ?? 0, influence));
    }
  }
  for (const [key, entry] of byKey) {
    for (const [agent, influence] of votes.get(key)!) {
      if (influence > 0) {
        entry.supportWeight += influence;
        entry.supportAgents.push(agent);
      }
    }
  }

  const approved: ActionIntent[] = [];
  const denied: { intent: ActionIntent; reason: string }[] = [];
  const approvedConsensus: ActionConsensus[] = [];
  const deniedConsensus: ActionConsensus[] = [];
  const escalatedConsensus: ActionConsensus[] = [];

  for (const entry of byKey.values()) {
    if (opposeWeight > 0) {
      entry.opposeWeight += opposeWeight;
      entry.opposeAgents.push(...opposeAgents.filter(a => !entry.opposeAgents.includes(a)));
    }
    if (vetoed && entry.intent.type !== "PAUSE") {
      // Veto is a separate hard gate; do not double-count its weight as an
      // additional opposition vote when that agent already opposes.
      entry.opposeAgents.push(...vetoAgents.filter(a => !entry.opposeAgents.includes(a)));
      entry.status = "DENIED";
      entry.reasons.push("Compliance veto active.");
      denied.push({ intent: entry.intent, reason: "Compliance veto active." });
      deniedConsensus.push(entry);
      continue;
    }
    if (entry.opposeWeight >= thresholdWeight) {
      entry.status = "DENIED";
      denied.push({ intent: entry.intent, reason: "Consensus oppose threshold exceeded." });
      deniedConsensus.push(entry);
    } else if (entry.supportWeight >= thresholdWeight) {
      entry.status = "APPROVED";
      approved.push(entry.intent);
      approvedConsensus.push(entry);
    } else {
      entry.status = "ESCALATE";
      escalatedConsensus.push(entry);
    }
  }

  const escalationReasons: string[] = [];
  const unknownRisk = !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100;
  if (unknownRisk) escalationReasons.push("Risk is unknown or invalid.");
  if (vetoed) escalationReasons.push("Compliance veto raised.");
  if (riskScore >= 90) escalationReasons.push("Risk score exceeds critical threshold.");
  if (escalatedConsensus.length) escalationReasons.push("Insufficient consensus; human oversight required.");

  return {
    decisionId: uuidv4(),
    createdAt: new Date().toISOString(),
    riskScore,
    rationale,
    signals,
    approvedActions: approved,
    deniedActions: denied,
    escalationRequired: unknownRisk || vetoed || riskScore >= 90 || escalatedConsensus.length > 0,
    escalationReasons,
    consensus: {
      thresholdWeight,
      totalWeight,
      approved: approvedConsensus,
      denied: deniedConsensus,
      escalated: escalatedConsensus,
    },
    agentWeights: weights,
  };
}
