# Security status

This repository is a local research demonstrator. Do not use real keys, real funds, public RPC deployments or untrusted token contracts. The supported application is PAPER-only and the contract lab uses a fresh ephemeral chain. Neither has undergone an independent security audit.

## Dependency checks (2026-09-21)

After a clean `npm ci`, `npm audit --omit=dev` reported **0 known vulnerabilities** for the locked runtime dependencies. This is a point-in-time package advisory result, not a proof that the application is secure.

The full development tree still reported **24 advisories: 8 high, 2 moderate and 14 low**. Most originate in the retained Hardhat 2 / solc toolchain and its transitive dependencies, including archive/temp-file/HTTP/test-serialization packages. The remaining tsx/esbuild advisory concerns its development server on Windows. We removed the toolbox umbrella and applied compatible dependency updates, but did not force an untested Hardhat 3/compiler migration or suppress the audit results.

The lab is restricted to locally maintained source, fixed test fixtures, an in-process chain and a pinned local compiler. Do not treat isolation as remediation: avoid processing untrusted projects, archives, remote compiler downloads or third-party RPC responses with this development stack. Migrating the lab to a fully patched supported toolchain is an outstanding prerequisite to a broader security claim.

CI currently blocks high/critical **runtime** dependency advisories. Full-tree audit findings remain visible through `npm audit` and must be reviewed separately. For example, see the upstream advisories for [archive allocation](https://github.com/advisories/GHSA-7q85-xj36-vmfc), [temporary-path traversal](https://github.com/advisories/GHSA-ph9p-34f9-6g65), and [test serialization](https://github.com/advisories/GHSA-5c6j-r48x-rmvq).

## Application boundaries

- The HTTP service is unauthenticated and localhost-only. Do not publish it as a hosted multi-user service.
- Audit replay relies on trusted local code/data and an independently retained expected head when provenance matters. Hashes alone do not establish external authorship.
- Paper idempotency is in-memory and run-scoped. It is not durable exactly-once execution.
- Contract owner and local mock DEX are trusted. A passing mock settlement is not proof of safe token custody or oracle design.
- Legacy FDC/LLM integrations and synthetic model experiments are not part of the supported pipeline.

For suspected security bugs, use GitHub's private vulnerability reporting if enabled. Never attach live keys, tokens or private financial data to a public issue.
