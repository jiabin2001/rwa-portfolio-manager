import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PAPER_SCENARIOS } from "@rpm/shared";
import { canonical, isScenario, replayAudit, runPaper } from "./engine.js";

async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!,
      value = args.shift();
    if (
      !key.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      key in options
    )
      throw new Error("Use --option value (no duplicate options)");
    options[key] = value;
  }
  const allowed =
    command === "replay"
      ? ["--input", "--head", "--report"]
      : ["--scenario", "--out"];
  if (Object.keys(options).some((k) => !allowed.includes(k)))
    throw new Error("Unknown option");
  if (command === "replay") {
    if (!options["--input"])
      throw new Error(
        "Usage: npm run replay -- --input <audit.jsonl> [--report <run.json>] [--head <trusted SHA-256>]",
      );
    const content = await readFile(path.resolve(options["--input"]), "utf8");
    const run = replayAudit(
      content
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)),
      options["--head"],
    );
    if (options["--report"]) {
      const saved: unknown = JSON.parse(
        await readFile(path.resolve(options["--report"]), "utf8"),
      );
      if (canonical(saved) !== canonical(run))
        throw new Error("Saved report does not match semantic replay");
    }
    console.log(
      `REPLAY PASS ${run.runId} ${run.status}\nauditHead=${run.auditHead}\ncostCents=${run.reconciliation.expectedCostCents}`,
    );
    return;
  }
  if (command !== "run") throw new Error("Expected run or replay");
  const scenario = options["--scenario"] ?? "normal";
  if (scenario !== "all" && !isScenario(scenario))
    throw new Error("Unknown scenario");
  const scenarios =
    scenario === "all" ? PAPER_SCENARIOS.map((s) => s.id) : [scenario];
  const out = path.resolve(options["--out"] ?? "artifacts/paper");
  for (const id of scenarios) {
    if (!isScenario(id)) throw new Error("Unknown scenario");
    const run = runPaper(id);
    replayAudit(run.audit, run.auditHead);
    const directory = path.join(out, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "run.json"),
      canonical(run) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "audit.jsonl"),
      run.audit.map(canonical).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "audit-head.txt"),
      run.auditHead + "\n",
      "utf8",
    );
    console.log(
      `${id}: ${run.status}; reconciliation=PASS; replay=PASS; ${directory}`,
    );
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
