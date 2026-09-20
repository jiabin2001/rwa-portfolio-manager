import { ObservationFrame } from "./types.js";
import { observeOnchain } from "./onchainObserver.js";
import { observeFdc } from "../fdc/fdcAdapter.js";
import type { DataPoint, PortfolioPosition } from "@rpm/shared";

export function extractNavUsd(data: DataPoint[], key: string): number | null {
  const point = data.find((d) => d.key === key);
  if (!point) return null;
  const value = point.value as any;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.nav ?? value.nav_usd_e6;
  if (typeof raw !== "number" && !(typeof raw === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(raw))) return null;
  const parsed = Number(raw) / (value.nav != null ? 1 : 1_000_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function applyNavToPositions(positions: PortfolioPosition[], navUsd: number | null): PortfolioPosition[] {
  if (navUsd == null || !Number.isFinite(navUsd) || navUsd <= 0) return positions;
  return positions.map((p) => {
    if (p.symbol !== "tBILL") return p;
    const qty = Number(p.quantity);
    if (!Number.isFinite(qty)) return p;
    const currentPrice = Number(p.price);
    const hasMarketPrice = Number.isFinite(currentPrice) && currentPrice > 0;
    if (hasMarketPrice) return p;
    const price = navUsd;
    const value = qty * navUsd;
    return {
      ...p,
      price: price.toFixed(6),
      value: value.toFixed(6),
    };
  });
}

export async function observe(): Promise<ObservationFrame> {
  const onchain = await observeOnchain();
  const fdc = await observeFdc();
  const navUsd = extractNavUsd(fdc, "fdc:nav:tBILL");
  return {
    data: [...onchain.data, ...fdc],
    positions: applyNavToPositions(onchain.positions, navUsd),
  };
}
