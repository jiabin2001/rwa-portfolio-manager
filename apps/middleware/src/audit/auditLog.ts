import fs from "node:fs";
import { Decision, Signal } from "@rpm/shared";
import { nowIso } from "../util/time.js";

export class AuditLog {
  constructor(private path: string) {}

  append(obj: unknown) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new TypeError("Audit records must be objects");
    }
    const line = JSON.stringify({ ...obj, ts: nowIso() });
    fs.appendFileSync(this.path, line + "\n", "utf-8");
  }

  signal(signal: Signal) {
    this.append({ type: "signal", signal });
  }

  decision(decision: Decision) {
    this.append({ type: "decision", decision });
  }

  error(err: unknown) {
    this.append({ type: "error", error: String(err) });
  }
}
