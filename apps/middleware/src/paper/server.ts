import http from "node:http";
import { PAPER_SCENARIOS, type PaperApiState } from "@rpm/shared";
import { isScenario, runPaper } from "./engine.js";

/** Local-only demo service, not an authenticated deployment-ready API. */
export function startPaperServer(port = 3001) {
  let run = runPaper("normal");
  const state = (): PaperApiState => ({
    ok: true,
    mode: "PAPER",
    liveExecutionEnabled: false,
    run,
  });
  const origins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
  const server = http.createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin && !origins.has(req.headers.origin))
      return reply(403, { ok: false, error: "Origin not allowed" });
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
    }
    const route = req.url?.split("?")[0];
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && route === "/api/state")
      return reply(200, state());
    if (req.method === "GET" && route === "/api/scenarios")
      return reply(200, { scenarios: PAPER_SCENARIOS });
    if (req.method === "POST" && route === "/api/run") {
      if (
        req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        return reply(415, { ok: false, error: "Expected application/json" });
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 4096) {
            reply(413, { ok: false, error: "Request too large" });
            req.resume();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("scenario" in body) ||
          !isScenario(body.scenario)
        )
          return reply(400, {
            ok: false,
            error: "Expected exactly one supported scenario",
          });
        const next = runPaper(body.scenario);
        run = next;
        return reply(200, state());
      } catch (error) {
        if (error instanceof SyntaxError)
          return reply(400, { ok: false, error: "Invalid JSON" });
        console.error("Paper run failed:", error);
        return reply(500, {
          ok: false,
          error: "Internal run failure; previous state retained",
        });
      }
    }
    return reply(404, { ok: false, error: "Not found" });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(port, "127.0.0.1");
  return server;
}
