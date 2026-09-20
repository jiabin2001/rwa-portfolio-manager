import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAPER_SCENARIOS, type PaperApiState } from "@rpm/shared";
import { startPaperServer } from "../src/paper/server.js";

let server: Server;
let base: string;
before(async () => {
  server = startPaperServer(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const read = async (): Promise<PaperApiState> => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  return res.json() as Promise<PaperApiState>;
};
const post = (
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" },
) => fetch(`${base}/api/run`, { method: "POST", headers, body });

test("local API advertises PAPER-only execution and publishes all scenarios", async () => {
  const state = await read();
  assert.equal(state.mode, "PAPER");
  assert.equal(state.liveExecutionEnabled, false);
  assert.equal(state.run.status, "CONFIRMED");
  const result = await fetch(`${base}/api/scenarios`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { scenarios: PAPER_SCENARIOS });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
});

test("all scenario POSTs succeed deterministically without enabling live execution", async () => {
  for (const { id } of PAPER_SCENARIOS) {
    const first = await post(JSON.stringify({ scenario: id }));
    assert.equal(first.status, 200);
    const body = await first.text();
    const second = await post(JSON.stringify({ scenario: id }));
    assert.equal(await second.text(), body);
    const state = JSON.parse(body) as PaperApiState;
    assert.equal(state.run.scenario, id);
    assert.equal(state.mode, "PAPER");
    assert.equal(state.liveExecutionEnabled, false);
    assert.ok(state.run.fills.every((fill) => fill.mode === "PAPER"));
  }
});

test("malformed JSON and unsupported request shapes retain the previous result", async () => {
  assert.equal(
    (await post(JSON.stringify({ scenario: "insufficient-consensus" }))).status,
    200,
  );
  const before = await read();
  for (const body of [
    "",
    "{",
    "null",
    "[]",
    "1",
    '"normal"',
    "{}",
    '{"scenario":"unknown"}',
    '{"scenario":"normal","mode":"LIVE"}',
    '{"scenario":"normal","execute":true}',
    '{"scenario":null}',
  ]) {
    const result = await post(body);
    assert.equal(result.status, 400, body);
    assert.equal((await result.json()).ok, false);
    assert.deepEqual(await read(), before, body);
  }
});

test("unsupported media types cannot mutate state", async () => {
  const before = await read();
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/jsonp",
    "application/json-seq",
  ]) {
    const result = await post('{"scenario":"normal"}', {
      "Content-Type": type,
    });
    assert.equal(result.status, 415, type);
    assert.deepEqual(await read(), before, type);
  }
  const missing = await post('{"scenario":"normal"}', {});
  assert.equal(missing.status, 415);
});

test("oversized bodies are rejected, while the exact 4096-byte boundary is accepted", async () => {
  const before = await read();
  const tooLarge = await post(" ".repeat(4097));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await read(), before);
  const body = '{"scenario":"normal"}';
  const exact = await post(body + " ".repeat(4096 - Buffer.byteLength(body)), {
    "Content-Type": "APPLICATION/JSON; charset=utf-8",
  });
  assert.equal(exact.status, 200);
  assert.equal((await exact.json()).run.scenario, "normal");
});

test("untrusted origins are denied for reads, preflight and mutation without changing state", async () => {
  const before = await read();
  for (const origin of [
    "https://evil.example",
    "http://localhost:5173.evil.example",
    "null",
    "http://localhost:5174",
  ]) {
    const response = await post('{"scenario":"missing-price"}', {
      "Content-Type": "application/json",
      Origin: origin,
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await read(), before);
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { Origin: origin } }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/run`, {
          method: "OPTIONS",
          headers: { Origin: origin },
        })
      ).status,
      403,
    );
  }
});

test("permitted local dashboard origins receive explicit CORS headers", async () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    const res = await fetch(`${base}/api/state`, {
      headers: { Origin: origin },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("vary"), "Origin");
    const options = await fetch(`${base}/api/run`, {
      method: "OPTIONS",
      headers: { Origin: origin },
    });
    assert.equal(options.status, 200);
    assert.equal(
      options.headers.get("access-control-allow-methods"),
      "GET, POST, OPTIONS",
    );
    assert.equal(
      options.headers.get("access-control-allow-headers"),
      "Content-Type",
    );
  }
});

test("API exposes no live execution endpoint or accepted live-mode override", async () => {
  const before = await read();
  for (const path of [
    "/api/execute",
    "/api/live",
    "/api/trade",
    "/api/run/live",
  ]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  }
  assert.equal((await post('{"scenario":"live"}')).status, 400);
  assert.equal(
    (await post('{"scenario":"normal","liveExecutionEnabled":true}')).status,
    400,
  );
  assert.deepEqual(await read(), before);
});

test("application entrypoint refuses LIVE mode before opening a server", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    {
      env: { ...process.env, EXECUTION_MODE: "LIVE", API_PORT: "3001" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only EXECUTION_MODE=PAPER is supported/);
  assert.equal(result.stdout.includes("PAPER API"), false);
});
