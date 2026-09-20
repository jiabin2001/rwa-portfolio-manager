import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
}

function run(args, cwd, name) {
  const p = spawn(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true });
  p.on("error", (error) => { console.error(`[${name}]`, error); stop(1); });
  p.on("exit", (code) => {
    if (!stopping) {
      console.error(`[${name}] stopped; shutting down the other service`);
      stop(code ?? 1);
    }
  });
  procs.push(p);
}

// Direct Node children avoid orphaned npm/cmd wrappers on Windows.
run(["--import", "tsx", "src/index.ts"], path.join(root, "apps/middleware"), "middleware");
run([path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js"), "--port", "5173", "--strictPort"], path.join(root, "apps/dashboard"), "dashboard");

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
