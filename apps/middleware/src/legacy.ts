import { InMemoryBus } from "./bus/inMemoryBus.js";
import { observe } from "./observe/index.js";
import { AuditLog } from "./audit/auditLog.js";
import { CONFIG } from "./config.js";

import { DataProvenanceAgent } from "./agents/dataProvenanceAgent.js";
import { ValuationOracleAgent } from "./agents/valuationOracleAgent.js";
import { LiquidityAgent } from "./agents/liquidityAgent.js";
import { CreditCounterpartyAgent } from "./agents/creditCounterpartyAgent.js";
import { ComplianceAgent } from "./agents/complianceAgent.js";
import { StrategyAgent } from "./agents/strategyAgent.js";
import { AnalystAgent } from "./agents/analystAgent.js";

import { computeRiskScore } from "./risk/riskSentinel.js";
import { decide } from "./orchestrator/consensus.js";
import { OnchainClient } from "./execution/onchainClient.js";
import { ExecutionAgent } from "./execution/executionAgent.js";
import { ReputationStore } from "./reputation/reputationStore.js";

import { startApiServer } from "./api/server.js";
import { updateRuntimeState } from "./state/runtimeState.js";
import {
  Effect,
  createClock,
  createLogger,
  createRuntime,
  type Clock,
  type Effect as EffectType,
  type Logger
} from "@rpm/shared";

// Retained for historical context, not a supported runtime or execution adapter.
throw new Error("Legacy live orchestration is retired. Run npm run dev for the verified PAPER workflow.");

const bus = new InMemoryBus();
const audit = new AuditLog(CONFIG.auditPath);

const agents = [
  new DataProvenanceAgent(),
  new ValuationOracleAgent(),
  new LiquidityAgent(),
  new CreditCounterpartyAgent(),
  new ComplianceAgent(),
  new StrategyAgent(),
  new AnalystAgent(),
];

const onchain = new OnchainClient();
const executor = new ExecutionAgent(onchain);
const reputation = new ReputationStore();

type MiddlewareEnv = {
  clock: Clock;
  log: Logger;
  bus: InMemoryBus;
  audit: AuditLog;
  agents: typeof agents;
  executor: ExecutionAgent;
};

const tickOnce: EffectType<MiddlewareEnv, void> = async (env, signal) => {
  if (signal.aborted) return;
  const tickAt = env.clock.nowIso();
  try {
    const frame = await observe();
    env.bus.publish("OBSERVATIONS", frame);

    updateRuntimeState({ lastTickAt: tickAt, lastObservedAt: tickAt, lastFrame: frame });

    const allSignals = (await Promise.all(env.agents.map((a) => a.run(frame)))).flat();
    allSignals.forEach((s) => env.audit.signal(s));
    env.bus.publish("SIGNALS", allSignals);
    updateRuntimeState({ lastSignals: allSignals });

    const liq =
      allSignals.find((s) => s.agent === "LiquidityAgent")?.metrics?.find((m) => m.name === "LiquidityStress")?.value;
    const cred =
      allSignals.find((s) => s.agent === "CreditCounterpartyAgent")?.metrics?.find((m) => m.name === "CreditScore")?.value;

    if (liq === undefined || cred === undefined) throw new Error("Risk inputs unavailable");

    const { score: riskScore, metrics } = computeRiskScore(frame.positions, { liquidityStress: liq, creditScore: cred });

    const baseWeight = 1 / env.agents.length;
    const baseWeights = Object.fromEntries(env.agents.map((a) => [a.name, baseWeight]));
    const effectiveWeights = Object.fromEntries(
      env.agents.map((a) => [a.name, reputation.getEffectiveWeight(baseWeight, a.name)])
    );

    const decision = decide(
      {
        weights: baseWeights,
        rule: { thresholdWeight: 0.67, vetoAgents: ["ComplianceAgent"] },
      },
      allSignals,
      riskScore,
      effectiveWeights
    );

    decision.riskMetrics = metrics;
    decision.rationale += "\n\nRisk Sentinel Metrics:\n" + metrics.map((m) => `- ${m.name}: ${m.value}`).join("\n");
    if (decision.consensus) reputation.applyConsensus(decision.consensus);

    env.audit.decision(decision);
    env.bus.publish("DECISIONS", decision);
    updateRuntimeState({ lastDecision: decision, lastRiskScore: riskScore });

    if (!decision.escalationRequired) {
      const execSignals = await env.executor.execute(frame, riskScore, decision.approvedActions);
      execSignals.forEach((s) => env.audit.signal(s));
    } else {
      env.audit.append({ type: "escalation", decisionId: decision.decisionId, note: "Human approval required." });
    }
  } catch (e) {
    env.audit.error(e);
    env.log.error("tick failed", e);
  }
};

const runLoop: EffectType<MiddlewareEnv, void> = async (env, signal) => {
  env.log.info(`RWA Portfolio Manager middleware starting… tick=${CONFIG.tickSeconds}s audit=${CONFIG.auditPath}`);

  const server = startApiServer();
  const onAbort = () => server.close();
  signal.addEventListener("abort", onAbort, { once: true });

  await tickOnce(env, signal);
  while (!signal.aborted) {
    await Effect.sleep<MiddlewareEnv>(CONFIG.tickSeconds * 1000)(env, signal);
    await tickOnce(env, signal);
  }
};

const runtime = createRuntime<MiddlewareEnv>({
  clock: createClock(),
  log: createLogger(),
  bus,
  audit,
  agents,
  executor
});

const run = runtime.run(runLoop);
run.promise.catch((e) => console.error(e));

process.on("SIGINT", () => run.cancel());
process.on("SIGTERM", () => run.cancel());
