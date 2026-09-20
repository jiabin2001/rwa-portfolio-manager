# Verification guide

## Clean checkout

Use Node 24.13.0 and npm 11.x, then run:

```bash
npm ci
npm run verify
npm run replay -- --input artifacts/paper/normal/audit.jsonl --report artifacts/paper/normal/run.json
npm -w contracts run demo
```

CI runs these checks on Windows and Linux with fixed Action commit references and uploads per-scenario artifacts. Package installation requires network access; no business workflow needs a remote service afterward. The Solidity compiler is a pinned npm package, not downloaded at build time. A runtime dependency audit is a separate network-dependent CI check, so new advisories may cause CI to fail even when the deterministic suite still passes.

## What to inspect

1. Compare cash/holdings/NAV against the worked README example. All monetary output is cents; rendered UI dollars are presentation only.
2. Open `run.json`: examine final status, data quality, consensus, constraints events, fills and reconciliation separately. A passed consensus does not imply a fill.
3. Check missing/stale data: `riskBefore`, `riskAfter` and both NAV fields must be null, and the ledger must be unchanged.
4. Check execution failure: consensus and constraints approve, but the final status is FAILED, there are no fills and the balances are unchanged.
5. Check duplicate voting: the audit reports eight ignored votes, support remains 1.0 and there is one fill. A separate regression proves repeated support from only the 40% agent cannot reach quorum.
6. Replay with a saved independent head: `npm run replay -- --input <audit.jsonl> --report <run.json> --head <sha256>`. A successful run prints `REPLAY PASS`; malformed/tampered evidence exits nonzero.

The regression suite alters a fill, rehashes a forged chain, truncates a valid stream and tests an incorrect anchor. It also tests NaN/Infinity/negative/overlarge amounts, integer overflow, conflicting idempotency keys, data validity, malicious or malformed API requests, and real local contract rollback. These are software behavior checks, not empirical validation of an investment strategy.

## Reproducibility scope

The checked-in fixture is hand-authored and synthetic. It is identified by `synthetic-rwa-daily-v1`; data/policy hashes are included in each report. JSON serialization is canonical and the event timestamp is fixed. Generated run IDs identify reproducible inputs, not a fresh wall-clock trading session. Two executions of the same scenario should have byte-identical audit and report files on the pinned runtime.

The contract lab creates a separate fresh in-process chain and independently asserts balance settlement. It does not consume the TypeScript paper action or certify the paper run.

## Before promoting beyond a demonstrator

Add licensed real issuer-level price/NAV histories with data provenance and point-in-time availability; calibrate and test risk estimates out of sample against no-trade and concentration-rule baselines; explicitly model liquidity, redemption delays and stress scenarios. Then implement transactional durable execution state, authenticated signed approvals, cross-layer policy parity, restart/retry recovery and monitoring. Independent security and model validation remain prerequisites for real funds.
