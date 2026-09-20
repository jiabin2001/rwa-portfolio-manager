import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PAPER_SCENARIOS } from "@rpm/shared";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/paper/cli.ts", import.meta.url));
const names = ["audit-head.txt", "audit.jsonl", "run.json"];

function cli(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("CLI export and replay round-trip only inside an isolated temporary directory", async (t) => {
  const temporaryParent = path.resolve(os.tmpdir());
  const temporaryRoot = await mkdtemp(
    path.join(temporaryParent, "rwa-paper-cli-"),
  );
  try {
    const first = path.join(temporaryRoot, "first export");
    const second = path.join(temporaryRoot, "second export");
    const original = path.join(first, "normal");
    const auditPath = path.join(original, "audit.jsonl");
    const reportPath = path.join(original, "run.json");
    let trustedHead = "";

    await t.test(
      "default and explicit normal exports are byte-identical, including paths with spaces",
      async () => {
        const one = cli("run", "--out", first);
        const two = cli("run", "--scenario", "normal", "--out", second);
        assert.equal(one.status, 0, one.stderr);
        assert.equal(two.status, 0, two.stderr);
        assert.match(
          one.stdout,
          /normal: CONFIRMED; reconciliation=PASS; replay=PASS/,
        );
        assert.deepEqual((await readdir(first)).sort(), ["normal"]);
        assert.deepEqual((await readdir(original)).sort(), names);
        for (const name of names) {
          assert.deepEqual(
            await readFile(path.join(original, name)),
            await readFile(path.join(second, "normal", name)),
            name,
          );
        }
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const events = (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        trustedHead = (
          await readFile(path.join(original, "audit-head.txt"), "utf8")
        ).trim();
        assert.match(trustedHead, /^[a-f0-9]{64}$/);
        assert.equal(events.length, 7);
        assert.equal(events.at(-1).hash, trustedHead);
        assert.equal(report.auditHead, trustedHead);
        assert.equal(report.status, "CONFIRMED");
        assert.equal(report.reconciliation.expectedCostCents, 20244);
        assert.equal(report.equityAfterCents, 100119756);
        assert.deepEqual(report.audit, events);
      },
    );

    await t.test(
      "replay checks the saved report against an independently retained head",
      async () => {
        // This in-memory anchor is retained from the original export and is not
        // reread from a subsequently edited report or audit stream.
        assert.ok(trustedHead);
        const result = cli(
          "replay",
          "--input",
          auditPath,
          "--report",
          reportPath,
          "--head",
          trustedHead,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /REPLAY PASS .* CONFIRMED/);
        assert.ok(result.stdout.includes(`auditHead=${trustedHead}`));
        assert.match(result.stdout, /costCents=20244/);
        const reformatted = path.join(temporaryRoot, "reformatted-report.json");
        await writeFile(
          reformatted,
          JSON.stringify(
            JSON.parse(await readFile(reportPath, "utf8")),
            null,
            2,
          ),
        );
        const sameData = cli(
          "replay",
          "--input",
          auditPath,
          "--report",
          reformatted,
          "--head",
          trustedHead,
        );
        assert.equal(sameData.status, 0, sameData.stderr);
      },
    );

    await t.test(
      "a wrong independently supplied head fails without a success message",
      () => {
        const result = cli(
          "replay",
          "--input",
          auditPath,
          "--report",
          reportPath,
          "--head",
          "f".repeat(64),
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /trusted anchor/);
        assert.equal(result.stdout.includes("REPLAY PASS"), false);
      },
    );

    await t.test(
      "changing only the saved report is detected even with intact audit and head",
      async () => {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        report.after.cashCents += 1;
        const tampered = path.join(temporaryRoot, "tampered-report.json");
        await writeFile(tampered, JSON.stringify(report));
        const result = cli(
          "replay",
          "--input",
          auditPath,
          "--report",
          tampered,
          "--head",
          trustedHead,
        );
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          /Saved report does not match semantic replay/,
        );
        assert.equal(result.stdout.includes("REPLAY PASS"), false);
        const unchanged = JSON.parse(await readFile(reportPath, "utf8"));
        assert.equal(unchanged.after.cashCents, 22741076);
      },
    );

    await t.test(
      "modified and truncated audit artifacts are rejected by the CLI",
      async () => {
        const events = (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        events[0].message = "forged data message";
        const forged = path.join(temporaryRoot, "forged-audit.jsonl");
        await writeFile(
          forged,
          events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
        const modified = cli(
          "replay",
          "--input",
          forged,
          "--head",
          trustedHead,
        );
        assert.equal(modified.status, 1);
        assert.match(modified.stderr, /hash\/sequence mismatch/);
        const truncated = path.join(temporaryRoot, "truncated-audit.jsonl");
        await writeFile(
          truncated,
          (await readFile(auditPath, "utf8"))
            .trim()
            .split("\n")
            .slice(0, -1)
            .join("\n") + "\n",
        );
        const incomplete = cli("replay", "--input", truncated);
        assert.equal(incomplete.status, 1);
        assert.match(incomplete.stderr, /Semantic replay mismatch/);
      },
    );

    await t.test(
      "all-scenario export creates and replays every documented artifact bundle",
      async () => {
        const destination = path.join(temporaryRoot, "all scenarios");
        const result = cli("run", "--scenario", "all", "--out", destination);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          (await readdir(destination)).sort(),
          PAPER_SCENARIOS.map((s) => s.id).sort(),
        );
        for (const { id } of PAPER_SCENARIOS) {
          const directory = path.join(destination, id);
          assert.deepEqual((await readdir(directory)).sort(), names);
          const head = (
            await readFile(path.join(directory, "audit-head.txt"), "utf8")
          ).trim();
          const replay = cli(
            "replay",
            "--input",
            path.join(directory, "audit.jsonl"),
            "--report",
            path.join(directory, "run.json"),
            "--head",
            head,
          );
          assert.equal(replay.status, 0, `${id}: ${replay.stderr}`);
          assert.match(replay.stdout, /REPLAY PASS/);
        }
      },
    );

    await t.test(
      "malformed options and missing inputs fail without publishing artifacts",
      async () => {
        for (const args of [
          ["run", "--scenario", "LIVE"],
          ["run", "--scenario", "normal", "--scenario", "normal"],
          ["run", "--live", "true"],
          ["replay"],
          ["replay", "--input", path.join(temporaryRoot, "missing.jsonl")],
        ]) {
          const result = cli(...args);
          assert.equal(result.status, 1, args.join(" "));
          assert.equal(result.stdout.includes("PASS"), false);
        }
      },
    );
  } finally {
    // Validate the exact freshly-created absolute target before recursive
    // cleanup; never delete a supplied output path or the temporary parent.
    const resolved = path.resolve(temporaryRoot);
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.ok(path.basename(resolved).startsWith("rwa-paper-cli-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
