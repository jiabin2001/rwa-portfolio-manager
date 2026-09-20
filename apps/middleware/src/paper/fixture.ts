/** Deliberately synthetic prices: no issuer, oracle, blockchain, or real-money claims. */
export const FIXTURE = {
  schemaVersion: 1,
  datasetId: "synthetic-rwa-daily-v1",
  provenance:
    "Hand-authored deterministic test data; not market observations or investment evidence.",
  asOf: "2026-01-31T16:00:00.000Z",
  observedAt: "2026-01-31T16:00:00.000Z",
  historyStart: "2026-01-01T16:00:00.000Z",
  intervalDays: 1,
  assetNames: { TRES: "Synthetic Treasury", PROP: "Synthetic Property" },
  pricesCents: { TRES: 10120, PROP: 9650 },
  // 31 closes, 30 daily returns; intentionally too short for empirical strategy validation.
  historyCents: {
    TRES: [
      10000, 10004, 10008, 10012, 10016, 10020, 10024, 10028, 10032, 10036,
      10040, 10044, 10048, 10052, 10056, 10060, 10064, 10068, 10072, 10076,
      10080, 10084, 10088, 10092, 10096, 10100, 10104, 10108, 10112, 10116,
      10120,
    ],
    PROP: [
      10000, 10060, 10030, 10080, 10040, 9980, 10020, 9900, 9850, 9970, 10000,
      9940, 9820, 9780, 9860, 9800, 9700, 9760, 9660, 9740, 9690, 9600, 9520,
      9680, 9600, 9640, 9560, 9630, 9590, 9680, 9650,
    ],
  },
  initialLedger: { cashCents: 10000000, units: { TRES: 7000, PROP: 2000 } },
} as const;

export const PAPER_POLICY = {
  version: "paper-policy-v1",
  maxQuoteAgeSeconds: 300,
  maxConcentration: 0.6,
  targetConcentration: 0.58,
  maxTurnover: 0.2,
  slippageBps: 10,
  feeBps: 5,
  threshold: 0.67,
  weights: { risk: 0.4, liquidity: 0.35, compliance: 0.25 },
} as const;
