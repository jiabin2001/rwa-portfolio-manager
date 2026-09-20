import { PortfolioPosition, RiskMetric } from "@rpm/shared";

/**
 * Very simple risk scoring (MVP):
 * - concentration proxy + liquidity proxy combination
 * - replace with historical returns VaR, stress tests, etc.
 */
export function computeRiskScore(positions: PortfolioPosition[], signals: { liquidityStress?: number; creditScore?: number } = {}): { score: number; metrics: RiskMetric[] } {
  if (!positions.length) throw new Error("Risk is unknown: portfolio has no priced positions");
  for (const p of positions) {
    const values = [p.quantity, p.price, p.value];
    if (values.some(v => typeof v !== "string" || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim()) || !Number.isFinite(Number(v))) ||
        Number(p.quantity) < 0 || Number(p.price) <= 0 || Number(p.value) < 0) {
      throw new Error(`Risk is unknown: invalid position ${p.symbol}`);
    }
    const expected = Number(p.quantity) * Number(p.price);
    if (!Number.isFinite(expected) || Math.abs(expected - Number(p.value)) > Math.max(0.000001, expected * 1e-8)) {
      throw new Error(`Risk is unknown: inconsistent position value for ${p.symbol}`);
    }
  }
  const total = positions.reduce((a, p) => a + Number(p.value), 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Risk is unknown: portfolio value must be positive");
  const sorted = [...positions].sort((a, b) => Number(b.value) - Number(a.value));
  const topShare = total ? Number(sorted[0]?.value ?? 0) / total : 0;

  for (const [name, value] of Object.entries({ liquidityStress: signals.liquidityStress, creditScore: signals.creditScore })) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Risk is unknown: missing or invalid ${name}`);
    }
  }
  const liquidity = signals.liquidityStress!;
  const credit = signals.creditScore!;

  // Proxy metrics for demo (replace with historical VaR/drawdown models)
  const var95 = Math.max(0, Math.min(1, 0.35 * topShare + 0.45 * liquidity + 0.2 * credit));
  const var99 = Math.max(0, Math.min(1, var95 * 1.15));
  const maxDrawdown = Math.max(0, Math.min(1, 0.4 * topShare + 0.3 * credit + 0.3 * liquidity));

  // 0..100 composite score
  const score = Math.round(100 * (0.3 * topShare + 0.3 * liquidity + 0.2 * credit + 0.2 * maxDrawdown));

  const metrics: RiskMetric[] = [
    { name: "Concentration", value: topShare, unit: "0..1", explanation: "Top position share of total value.", inputs: { topShare, total } },
    { name: "LiquidityStress", value: liquidity, unit: "0..1", explanation: "Liquidity stress proxy from LiquidityAgent.", inputs: { liquidity } },
    { name: "CreditScore", value: credit, unit: "0..1", explanation: "Credit proxy from CreditCounterpartyAgent.", inputs: { credit } },
    { name: "VaR_95_1d", value: var95, unit: "0..1", horizon: "1d", explanation: "Proxy VaR (95%) derived from composition and liquidity proxies.", inputs: { topShare, liquidity, credit } },
    { name: "VaR_99_1d", value: var99, unit: "0..1", horizon: "1d", explanation: "Proxy VaR (99%) derived from VaR95.", inputs: { var95 } },
    { name: "MaxDrawdown", value: maxDrawdown, unit: "0..1", explanation: "Proxy max drawdown using concentration/credit/liquidity factors.", inputs: { topShare, liquidity, credit } },
  ];
  return { score, metrics };
}
