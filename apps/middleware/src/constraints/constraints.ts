import { ActionIntent, ConstraintCheckResult, ConstraintViolation, PortfolioPosition } from "@rpm/shared";

export type ConstraintContext = {
  positions: PortfolioPosition[];
  riskScore: number;
  // add: investor profile, jurisdiction, chain state, etc.
  dynamic: Record<string, unknown>;
};

function ok(): ConstraintCheckResult {
  return { ok: true, violations: [] };
}

function fail(...violations: ConstraintViolation[]): ConstraintCheckResult {
  return { ok: false, violations };
}

function invalid(message: string): ConstraintCheckResult {
  return fail({ layer: "EXECUTION", code: "INVALID_ACTION_PARAMETERS", message, blocking: true });
}

function boundedNumber(value: unknown, min: number, max: number, includeMin = true): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    (includeMin ? value >= min : value > min) && value <= max;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

/** Legacy demo policy, not a venue quote or an execution-risk model. */
export function validateActionParameters(intent: ActionIntent): ConstraintCheckResult {
  if (!intent || !intent.params || typeof intent.params !== "object" || Array.isArray(intent.params)) {
    return invalid("Action params must be an object.");
  }
  if (typeof intent.reason !== "string" || !intent.reason.trim()) return invalid("Action reason is required.");
  if (intent.route && (!Number.isSafeInteger(intent.route.chainId) || intent.route.chainId <= 0 ||
      (intent.route.venue !== undefined && !nonempty(intent.route.venue)))) return invalid("Invalid action route.");
  const p = intent.params;
  const allowed: Record<string, string[]> = {
    HEDGE: ["against", "instrument", "notionalPct", "slippageBps", "turnover"],
    REBALANCE: ["asset", "assetClass", "targetDeltaPct", "slippageBps", "turnover"],
    REDEEM: ["asset", "assetClass", "amountPct", "slippageBps", "turnover"],
    PAUSE: [], UNPAUSE: [],
    UPDATE_CONSTRAINTS: ["maxTurnover", "maxSlippageBps", "defensiveMode"],
  };
  if (!Object.hasOwn(allowed, intent.type)) return invalid("Unsupported action type.");
  if (Object.keys(p).some(key => !allowed[intent.type].includes(key))) return invalid("Unknown action parameter.");
  if (p.turnover !== undefined && !boundedNumber(p.turnover, 0, 1)) return invalid("Invalid turnover.");
  if (p.slippageBps !== undefined && (!boundedNumber(p.slippageBps, 0, 10_000) || !Number.isInteger(p.slippageBps))) {
    return invalid("Slippage must be a finite integer in basis points.");
  }
  if ((intent.type === "HEDGE" || intent.type === "REBALANCE") && p.slippageBps === undefined) {
    return invalid("Market actions require a slippage limit.");
  }
  if (intent.type === "HEDGE" && (!nonempty(p.against) || !nonempty(p.instrument) || !boundedNumber(p.notionalPct, 0, 0.2, false))) {
    return invalid("HEDGE requires a target, instrument and notionalPct in (0, 0.2].");
  }
  if (intent.type === "REBALANCE" || intent.type === "REDEEM") {
    if (Number(nonempty(p.asset)) + Number(nonempty(p.assetClass)) !== 1) return invalid("Specify exactly one asset or assetClass.");
    if ((p.asset !== undefined && !nonempty(p.asset)) || (p.assetClass !== undefined && !nonempty(p.assetClass))) return invalid("Invalid asset target.");
    if (intent.type === "REBALANCE" && (!boundedNumber(p.targetDeltaPct, -0.2, 0.2) || p.targetDeltaPct === 0)) {
      return invalid("REBALANCE requires a nonzero targetDeltaPct in [-0.2, 0.2].");
    }
    if (intent.type === "REDEEM" && !boundedNumber(p.amountPct, 0, 0.2, false)) return invalid("REDEEM amountPct must be in (0, 0.2].");
  }
  if (intent.type === "UPDATE_CONSTRAINTS") {
    if (!Object.keys(p).length || (p.maxTurnover !== undefined && !boundedNumber(p.maxTurnover, 0, 0.2, false)) ||
        (p.maxSlippageBps !== undefined && (!boundedNumber(p.maxSlippageBps, 0, 100) || !Number.isInteger(p.maxSlippageBps))) ||
        (p.defensiveMode !== undefined && typeof p.defensiveMode !== "boolean")) return invalid("Invalid bounded constraint update.");
  }
  return ok();
}

function actionSize(intent: ActionIntent): number {
  if (intent.type === "HEDGE") return intent.params.notionalPct as number;
  if (intent.type === "REBALANCE") return Math.abs(intent.params.targetDeltaPct as number);
  if (intent.type === "REDEEM") return intent.params.amountPct as number;
  return 0;
}

/**
 * Regulatory layer (MVP):
 * - investor whitelist / accreditation checks
 * - banned jurisdictions
 * - disclosure gating
 */
export function checkRegulatory(intent: ActionIntent, ctx: ConstraintContext): ConstraintCheckResult {
  if (intent.type === "REDEEM" && ctx.dynamic["investorAccredited"] !== true) {
    return fail({
      layer: "REGULATORY",
      code: "INVESTOR_NOT_ACCREDITED",
      message: "Investor must be accredited to redeem this instrument.",
      blocking: true,
    });
  }
  return ok();
}

/**
 * Risk layer (MVP):
 * - max position size per asset class
 * - concentration limits
 * - drawdown defensive mode
 */
export function checkRisk(intent: ActionIntent, ctx: ConstraintContext): ConstraintCheckResult {
  const parameters = validateActionParameters(intent);
  if (!parameters.ok) return parameters;
  if (ctx.dynamic["defensiveMode"] !== undefined && typeof ctx.dynamic["defensiveMode"] !== "boolean") return invalid("Invalid defensiveMode policy.");
  const defensive = ctx.dynamic["defensiveMode"] === true;
  if (defensive && actionSize(intent) > 0) {
    const maxTurnover = ctx.dynamic["maxTurnover"] ?? 0.05;
    if (!boundedNumber(maxTurnover, 0, 0.2, false)) return invalid("Invalid maxTurnover policy.");
    // All legacy size fractions are defined against portfolio NAV. Never trust
    // an LLM/model's self-reported turnover to authorize a larger action.
    const turnover = actionSize(intent);
    if (turnover > maxTurnover) {
      return fail({
        layer: "RISK",
        code: "DEFENSIVE_TURNOVER_LIMIT",
        message: `Turnover ${turnover} exceeds defensive max ${maxTurnover}.`,
        blocking: true,
        context: { turnover, maxTurnover },
      });
    }
  }
  return ok();
}

/**
 * Execution layer (MVP):
 * - slippage caps, venue allow-list, gas bounds
 */
export function checkExecution(intent: ActionIntent, ctx: ConstraintContext): ConstraintCheckResult {
  const parameters = validateActionParameters(intent);
  if (!parameters.ok) return parameters;
  const slip = (intent.params["slippageBps"] ?? 0) as number;
  const maxSlip = ctx.dynamic["maxSlippageBps"] ?? 50;
  if (!boundedNumber(maxSlip, 0, 100) || !Number.isInteger(maxSlip)) return invalid("Invalid maxSlippageBps policy.");
  if (slip > maxSlip) {
    return fail({
      layer: "EXECUTION",
      code: "SLIPPAGE_TOO_HIGH",
      message: `Slippage ${slip} bps exceeds max ${maxSlip} bps.`,
      blocking: true,
      context: { slip, maxSlip },
    });
  }
  return ok();
}

/**
 * Operations layer (MVP):
 * - require escalation on CRITICAL conditions
 * - circuit breaker is handled on-chain (owner/multisig)
 */
export function checkOperations(intent: ActionIntent, ctx: ConstraintContext): ConstraintCheckResult {
  if (!boundedNumber(ctx.riskScore, 0, 100) && intent.type !== "PAUSE") return fail({
    layer: "OPERATIONS", code: "UNKNOWN_RISK", message: "Risk is unknown; only PAUSE is allowed.", blocking: true,
  });
  if ((intent.type === "UNPAUSE" || intent.type === "UPDATE_CONSTRAINTS") && ctx.dynamic["humanApproved"] !== true) return fail({
    layer: "OPERATIONS", code: "HUMAN_APPROVAL_REQUIRED", message: "Policy changes and UNPAUSE require explicit human approval.", blocking: true,
  });
  if (ctx.riskScore >= 90 && intent.type !== "PAUSE") {
    return fail({
      layer: "OPERATIONS",
      code: "ESCALATION_REQUIRED",
      message: "Risk score critical; only PAUSE allowed without human approval.",
      blocking: true,
      context: { riskScore: ctx.riskScore },
    });
  }
  return ok();
}

export function checkAll(intent: ActionIntent, ctx: ConstraintContext): ConstraintCheckResult {
  const parameters = validateActionParameters(intent);
  if (!parameters.ok) return parameters;
  const results = [checkRegulatory(intent, ctx), checkRisk(intent, ctx), checkExecution(intent, ctx), checkOperations(intent, ctx)];
  const violations = results.flatMap(r => r.violations);
  return violations.length ? { ok: false, violations } : { ok: true, violations: [] };
}
