# Supported architecture and trust boundaries

## Pure core, explicit I/O

`apps/middleware/src/paper/engine.ts` has no network, wall clock, random generator or filesystem access. `runPaper(scenario)` produces the entire result from a versioned fixture and policy. The logical event time is the fixture valuation time, not the user's current time. CLI file writes and the HTTP server are separate boundaries; the React dashboard only inspects API output.

The first audit event binds the dataset hash, policy hash, scenario, quote timestamp, initial ledger and prices. Events use sorted-key JSON encoding, SHA-256 and a previous-hash link. The final event contains the resulting ledger, risk and reconciliation. A run ID hashes the scenario and dataset/policy identities; an action ID additionally binds its terms. No random UUID or fake transaction hash is used in this workflow.

## State transitions

```text
DATA invalid ────────────────────────────────────────→ BLOCKED
DATA valid → RISK → no breach ────────────────────────→ NO_ACTION
                 → PROPOSE → CONSENSUS insufficient ─→ ESCALATED
                                      denied ───────→ BLOCKED
                                      approved
                                        ↓
                              CONSTRAINTS denied ───→ BLOCKED
                                          approved
                                            ↓
                                  EXECUTION rejected → FAILED
                                            filled ─→ CONFIRMED
All published outcomes → RECONCILIATION → AUDIT / REPLAY
```

All current fixtures require a proposal except data-quality failures; the NO_ACTION branch is supported but is not one of the seven fixed scenarios. Reconciliation must pass before a result is returned. A trade failure is a business outcome, not HTTP success masquerading as a confirmed trade: clients must inspect `run.status`. An unexpected internal invariant failure returns HTTP 500 and retains the previous complete state.

## Accounting and risk

- Money and prices use integer cents; positions use whole shares. BigInt intermediate multiplication prevents unsafe monetary products; conversion outside JavaScript's safe-integer range fails. Fractional tokens and arbitrary token decimals are intentionally unsupported.
- Mid-price NAV is cash plus the marked value of holdings. Cash earns no interest.
- A sell fill uses `floor(midCents × 9990 / 10000)`. Fee is `floor(grossCents × 5 / 10000)`. Cash increases by gross minus fee; shares decrease by the filled quantity.
- Reconciliation checks cash change against net fills, each holding against filled units, and NAV change against negative fee plus slippage costs. When quotes are untrusted, NAV/risk stay null; only unchanged-ledger reconciliation is available.
- Historical simulation reprices the same current portfolio across 31 daily closes. Return is consecutive historical NAV ratio minus one. VaR is the nearest-rank 95% quantile of losses, floored at zero. ES is the mean of losses at or above that quantile, also floored at zero. Drawdown uses historical running peak NAV. Ties can include more than 5% of observations in ES.
- Only concentration drives the sell rule. There is no optimizer, no trained model, and no claim of improved VaR/ES or return. Cash and the post-fill holdings are held constant throughout each risk window.

## Execution and persistence

The broker rechecks constraints immediately before execution, computes a new ledger, and only then commits the ledger and idempotency record in the same synchronous in-memory operation. Injected execution failure occurs before either mutation. Retrying the identical action/quote pair returns the original fill; changing either under the same key fails.

This is **run-scoped** idempotency, not a database transaction, restart recovery, or multi-process exactly-once guarantee. Each scenario resets to the fixture. The API stores only the latest complete run in memory. The CLI is the supported durable evidence exporter; three files are written individually, not as an atomic durable journal. A crash during export may leave incomplete evidence; replay/report comparison rejects incomplete or inconsistent content. Running two exporters into the same directory is unsupported; choose different `--out` paths.

## Threat model and limitations

The supported workflow trusts the checked-out source, local fixture, fixed policy, runtime and filesystem. Votes are deterministic local rule outputs, not authenticated messages. The local API has no accounts or authorization and must not be exposed publicly. It binds IPv4 loopback, bounds request size/time, allows only two local dashboard origins, validates the request schema and refuses unknown scenarios. The Vite server is also for local development only.

Replay first checks the chain, then requires an exact semantic match against a fresh run. Rehashing altered fills or truncating valid prefixes therefore still fails. A different valid scenario is not an invalid run; verify the independently stored expected head via `--head` to bind the intended scenario. The head file beside the log is convenient but **not an independent trust anchor**. This is tamper-evident relative to trusted code/data, not tamper-proof or externally timestamped evidence.

Legacy FDC decoding now accepts known NAV fields or the declared ABI tuple only, but it is not cryptographic attestation verification. Legacy live orchestration throws on startup. Legacy proxy risk scores and the Python random-return model are not called by the supported pipeline.

The independent contract lab trusts an owner, an allowlist and a local mock DEX. It is not production custody. It uses separate policy semantics and is not called from the paper broker. See its README for limitations, including per-action turnover and outstanding-signature membership changes.

## API

- `GET /api/state` → `{ ok: true, mode: "PAPER", liveExecutionEnabled: false, run }`.
- `GET /api/scenarios` → the seven scenario IDs, labels and descriptions.
- `POST /api/run` with JSON `{ "scenario": "normal" }` → a complete new state.

Unsupported content types return 415; invalid JSON/scenario/schema returns 400; oversized bodies return 413; disallowed origins return 403. Failed requests must not replace the previous run. The UI cancels superseded requests and does not append fabricated historical observations.
