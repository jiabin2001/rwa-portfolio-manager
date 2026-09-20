import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { DataPoint } from "@rpm/shared";
import { nowIso } from "../util/time.js";
import { CONFIG } from "../config.js";

const FdcHubAbi = parseAbi(["function requestAttestation(bytes data) payable"]);
const FdcFeeConfigAbi = parseAbi(["function getRequestFee(bytes data) view returns (uint256)"]);

type FdcCache = {
  lastOk?: {
    key: string;
    observedAt: string;
    url: string;
    roundId: number;
    requestBytes: string;
    response?: unknown;
    proof?: unknown;
  };
  pending?: {
    key: string;
    requestedAt: string;
    url: string;
    roundIdHint: number;
    requestBytes: string;
  };
};

const CACHE_PATH = process.env.FDC_CACHE_PATH ?? "./fdc_cache.json";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveSafeInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "bigint" &&
      !(typeof value === "string" && /^[0-9]+$/.test(value))) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/** Decode only the documented NAV field/wrappers; unrelated numeric leaves are
 * never prices. This validates data shape, NOT the FDC cryptographic proof. */
export function findNavUsdE6(value: unknown): number | null {
  const root = record(value);
  if (!root) return null;
  const response = record(root.response);
  const body = record(root.responseBody) ?? record(response?.responseBody);
  const candidates = [root, response, body, record(body?.response)].filter((v): v is Record<string, unknown> => v !== null);
  const explicit = candidates.filter(v => Object.hasOwn(v, "nav_usd_e6"));
  if (explicit.length) {
    const values = explicit.map(v => positiveSafeInteger(v.nav_usd_e6));
    return values.every(v => v !== null && v === values[0]) ? values[0] : null;
  }
  const encoded = body?.abi_encoded_data ?? body?.abiEncodedData;
  if (typeof encoded !== "string" || !/^0x[0-9a-fA-F]{128}$/.test(encoded)) return null;
  // This adapter supports exactly (uint256 ts, uint256 nav_usd_e6). The
  // placeholder SWAPI schema and any different configured tuple are rejected.
  try {
    const schema = JSON.parse(CONFIG.fdcWeb2Abi);
    const components = schema?.components;
    if (schema?.type !== "tuple" || !Array.isArray(components) || components.length !== 2 ||
        components[0]?.name !== "ts" || components[0]?.type !== "uint256" ||
        components[1]?.name !== "nav_usd_e6" || components[1]?.type !== "uint256") return null;
    const [, nav] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], encoded as Hex);
    return positiveSafeInteger(nav);
  } catch {
    return null;
  }
}

function loadCache(): FdcCache {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function saveCache(c: FdcCache) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); } catch {}
}

function toUtf8HexString(data: string): string {
  const hex = Array.from(data).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return "0x" + hex.padEnd(64, "0");
}

function makeClients() {
  if (!CONFIG.flareRpcUrl) throw new Error("Missing FLARE_RPC_URL");
  if (!CONFIG.executorPrivateKey) throw new Error("Missing EXECUTOR_PRIVATE_KEY (pays FDC request fee)");
  const chain = {
    id: CONFIG.chainId,
    name: CONFIG.chainId === 114 ? "Flare Coston2" : "Flare",
    nativeCurrency: { name: "FLR", symbol: "FLR", decimals: 18 },
    rpcUrls: { default: { http: [CONFIG.flareRpcUrl] }, public: { http: [CONFIG.flareRpcUrl] } },
  } as const;

  const account = privateKeyToAccount(CONFIG.executorPrivateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http(CONFIG.flareRpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(CONFIG.flareRpcUrl), account });
  return { publicClient, walletClient };
}

async function prepareWeb2JsonRequest(apiUrl: string, postProcessJq: string, abiSignature: string): Promise<{ abiEncodedRequest: Hex } | null> {
  if (!CONFIG.web2jsonVerifierUrl) throw new Error("Missing WEB2JSON_VERIFIER_URL");

  const verifierUrl = CONFIG.web2jsonVerifierUrl.replace(/\/+$/, "/") + "Web2Json/prepareRequest";

  const request = {
    attestationType: toUtf8HexString("Web2Json"),
    sourceId: toUtf8HexString("PublicWeb2"),
    requestBody: {
      url: apiUrl,
      httpMethod: "GET",
      headers: "{}",
      queryParams: "{}",
      body: "{}",
      postProcessJq,
      abiSignature,
    },
  };

  const resp = await fetch(verifierUrl, {
    method: "POST",
    headers: { "X-API-KEY": CONFIG.flareApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Web2Json verifier error: ${resp.status} ${resp.statusText} ${text}`);
  }
  const data: any = await resp.json();
  if (!data?.abiEncodedRequest) return null;
  return { abiEncodedRequest: data.abiEncodedRequest as Hex };
}

function estimateRoundId(blockTimestampSec: number): number {
  // votingEpochDurationSeconds=90, firsVotingRoundStartTs=1658430000
  const firstVotingRoundStart = 1658430000;
  const roundSeconds = 90;
  const d = Math.max(0, blockTimestampSec - firstVotingRoundStart);
  return Math.floor(d / roundSeconds);
}

async function submitRequestAndGetRoundHint(abiEncodedRequest: Hex): Promise<{ txHash: Hex; roundHint: number }> {
  if (!CONFIG.fdcHubAddress) throw new Error("Missing FDC_HUB_ADDRESS");
  if (!CONFIG.fdcFeeConfigAddress) throw new Error("Missing FDC_FEE_CONFIG_ADDRESS");
  const { publicClient, walletClient } = makeClients();

  const fee = await publicClient.readContract({
    address: CONFIG.fdcFeeConfigAddress as Address,
    abi: FdcFeeConfigAbi,
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });

  const txHash = await walletClient.writeContract({
    address: CONFIG.fdcHubAddress as Address,
    abi: FdcHubAbi,
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: fee as bigint,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash! });
  const ts = Number(block.timestamp);

  const current = estimateRoundId(ts);
  return { txHash, roundHint: current + 1 };
}

async function retrieveProofByRequestRound(requestBytes: Hex, roundId: number): Promise<any | null> {
  const url = CONFIG.fdcDaUrl.replace(/\/+$/, "") + "/api/v1/fdc/proof-by-request-round";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": CONFIG.flareApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ votingRoundId: roundId, requestBytes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  return await resp.json();
}

async function tryRetrieveAround(requestBytes: Hex, roundHint: number): Promise<{ roundId: number; payload: any } | null> {
  const candidates = [roundHint - 1, roundHint, roundHint + 1, roundHint + 2].filter((x) => x >= 0);
  for (const rid of candidates) {
    const p = await retrieveProofByRequestRound(requestBytes, rid);
    if (p) return { roundId: rid, payload: p };
  }
  return null;
}

export async function observeFdc(): Promise<DataPoint[]> {
  const ts = nowIso();

  if (CONFIG.fdcMode === "mock") {
    return [{
      key: "fdc:web2json:demo",
      value: { note: "mock" },
      observedAt: ts,
      source: "FDC:Web2Json",
      confidence: 0.3,
      meta: { status: "mock" },
    }];
  }

  if (CONFIG.fdcMode !== "web2json") return [];

  const key = "fdc:web2json:demo";
  const cache = loadCache();

  const apiUrl = CONFIG.fdcWeb2Url;
  const postProcessJq = CONFIG.fdcWeb2Jq;
  const abiSignature = CONFIG.fdcWeb2Abi;

  if (cache.pending?.requestBytes) {
    const attempt = await tryRetrieveAround(cache.pending.requestBytes as Hex, cache.pending.roundIdHint);
    if (attempt) {
      cache.lastOk = {
        key,
        observedAt: ts,
        url: cache.pending.url,
        roundId: attempt.roundId,
        requestBytes: cache.pending.requestBytes,
        response: attempt.payload?.response ?? attempt.payload,
        proof: attempt.payload?.proof ?? undefined,
      };
      delete cache.pending;
      saveCache(cache);
    } else {
      saveCache(cache);
      return [{
        key,
        value: { status: "pending", url: cache.pending.url, roundIdHint: cache.pending.roundIdHint },
        observedAt: ts,
        source: "FDC:Web2Json",
        confidence: 0.2,
        meta: { status: "pending", requestBytes: cache.pending.requestBytes },
      }];
    }
  }

  if (cache.lastOk?.observedAt) {
    const ageMs = Date.now() - Date.parse(cache.lastOk.observedAt);
    if (ageMs < 5 * 60_000) {
      const responsePayload = cache.lastOk.response ?? { status: "ok" };
      const points: DataPoint[] = [{
        key,
        value: responsePayload,
        observedAt: cache.lastOk.observedAt,
        source: "FDC:Web2Json",
        confidence: 0.9,
        meta: { status: "ok", roundId: cache.lastOk.roundId, requestBytes: cache.lastOk.requestBytes, proof: cache.lastOk.proof },
      }];

      const navUsdE6 = findNavUsdE6(responsePayload);
      if (navUsdE6 != null && Number.isFinite(navUsdE6)) {
        points.push({
          key: "fdc:nav:tBILL",
          value: { nav_usd_e6: navUsdE6, nav: navUsdE6 / 1_000_000 },
          observedAt: cache.lastOk.observedAt,
          source: "FDC:Web2Json",
          confidence: 0.9,
          meta: { status: "ok", roundId: cache.lastOk.roundId, requestBytes: cache.lastOk.requestBytes },
        });
      }

      return points;
    }
  }

  const prepared = await prepareWeb2JsonRequest(apiUrl, postProcessJq, abiSignature);
  if (!prepared) {
    return [{ key, value: { status: "error", reason: "prepare_failed" }, observedAt: ts, source: "FDC:Web2Json", confidence: 0.1 }];
  }

  const submit = await submitRequestAndGetRoundHint(prepared.abiEncodedRequest);
  cache.pending = { key, requestedAt: ts, url: apiUrl, roundIdHint: submit.roundHint, requestBytes: prepared.abiEncodedRequest };
  saveCache(cache);

  return [{
    key,
    value: { status: "requested", url: apiUrl, roundIdHint: submit.roundHint, txHash: submit.txHash },
    observedAt: ts,
    source: "FDC:Web2Json",
    confidence: 0.3,
    meta: { status: "requested", requestBytes: prepared.abiEncodedRequest },
  }];
}
