import { DataPoint, PortfolioPosition } from "@rpm/shared";
import { nowIso } from "../util/time.js";
import { CONFIG } from "../config.js";

/**
 * MVP stub:
 * - Replace with real chain reads (ethers/viem) to pull:
 *   positions, vault balances, DEX pool reserves, oracle prices, etc.
 */
export async function observeOnchain(): Promise<{ data: DataPoint[]; positions: PortfolioPosition[] }> {
  const ts = nowIso();
  const data: DataPoint[] = [];

  const ids = CONFIG.coingeckoIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const symbols = CONFIG.coingeckoSymbols
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const symbolToId = new Map<string, string>();
  for (let i = 0; i < ids.length; i++) {
    const symbol = symbols[i] ?? ids[i];
    symbolToId.set(symbol, ids[i]);
  }

  const pricesById = await fetchCoingeckoPrices(ids, CONFIG.coingeckoVsCurrency);

  for (const [symbol, id] of symbolToId.entries()) {
    const price = pricesById[id];
    if (Number.isFinite(price)) {
      data.push({
        key: `price:coingecko:${symbol}`,
        value: { id, price, vs: CONFIG.coingeckoVsCurrency },
        observedAt: ts,
        source: "coingecko:simple",
        confidence: 0.85,
      });
    }
  }

  const tBillId = symbolToId.get("tBILL");
  const tReId = symbolToId.get("tRE");
  const tBillPrice = tBillId ? pricesById[tBillId] : undefined;
  const tRePrice = tReId ? pricesById[tReId] : undefined;
  if (typeof tBillPrice !== "number" || !Number.isFinite(tBillPrice) || tBillPrice <= 0 ||
      typeof tRePrice !== "number" || !Number.isFinite(tRePrice) || tRePrice <= 0) {
    throw new Error("Market data unavailable: both tBILL and tRE require a valid positive price");
  }
  if (![CONFIG.positionQtyTbill, CONFIG.positionQtyTre].every(q => Number.isFinite(q) && q >= 0) ||
      !Number.isFinite(tBillPrice * CONFIG.positionQtyTbill) || !Number.isFinite(tRePrice * CONFIG.positionQtyTre)) {
    throw new Error("Invalid demo position sizing");
  }

  data.push(
    {
      key: "onchain:chainId",
      value: CONFIG.chainId,
      observedAt: ts,
      source: "onchain:rpc",
      confidence: 0.9,
    },
    {
      key: "onchain:gasPriceGwei",
      value: 0.02,
      observedAt: ts,
      source: "onchain:rpc",
      confidence: 0.6,
    }
  );

  const positions: PortfolioPosition[] = [
    {
      assetId: "0xTokenizedTBill",
      symbol: "tBILL",
      quantity: String(CONFIG.positionQtyTbill),
      price: String(tBillPrice),
      value: String(tBillPrice * CONFIG.positionQtyTbill),
      tags: ["rwa", "treasury"],
      chainId: CONFIG.chainId,
    },
    {
      assetId: "0xTokenizedRE",
      symbol: "tRE",
      quantity: String(CONFIG.positionQtyTre),
      price: String(tRePrice),
      value: String(tRePrice * CONFIG.positionQtyTre),
      tags: ["rwa", "real-estate"],
      chainId: CONFIG.chainId,
    },
  ];

  return { data, positions };
}

async function fetchCoingeckoPrices(ids: string[], vs: string): Promise<Record<string, number>> {
  if (!ids.length) throw new Error("Market data unavailable: configure CoinGecko asset IDs");
  const url = new URL(CONFIG.coingeckoBaseUrl);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("vs_currencies", vs);
  const res = await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Market price request failed: HTTP ${res.status}`);
  const json: any = await res.json();
  const out: Record<string, number> = {};
  for (const id of ids) {
    const price = json?.[id]?.[vs];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error(`Market data unavailable: invalid price for ${id}`);
    out[id] = price;
  }
  return out;
}
