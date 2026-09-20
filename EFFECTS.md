# Effect boundaries

The supported paper workflow now uses a pure deterministic core in `apps/middleware/src/paper/engine.ts` with explicit I/O adapters:

- `fixture.ts`: versioned synthetic data, fixed logical time and policy; no downloads.
- `cli.ts`: artifact export and replay input; process exit status exposes verification failure.
- `server.ts`: bounded local HTTP requests and publication of the last complete state.
- `apps/dashboard/`: cancellable UI requests and presentation, no polling-derived price history.

The retained `packages/shared/src/effects.ts` abstraction belongs to the historical prototype. Its sleep cancellation now cleans up abort listeners and its HTTP helper has time bounds; regression tests cover these behaviors. The retired `legacy.ts` refuses to start. The Python random-return experiment and live FDC/LLM adapters are not part of the supported workflow. Do not infer active integrations from the presence of those source files.
