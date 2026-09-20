import "dotenv/config";
import { startPaperServer } from "./paper/server.js";

if (process.env.EXECUTION_MODE && process.env.EXECUTION_MODE !== "PAPER") {
  throw new Error("Only EXECUTION_MODE=PAPER is supported. Live execution is intentionally disabled.");
}
const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid API_PORT");
const server = startPaperServer(port);
server.on("listening",() => console.log(`PAPER API http://127.0.0.1:${port} — synthetic fixture; live execution disabled`));
server.on("error", error => { console.error(error); process.exitCode=1; });
for (const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,() => server.close());
