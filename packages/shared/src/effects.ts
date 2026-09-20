export type Effect<Env, A> = (env: Env, signal: AbortSignal) => Promise<A>;

export type RunHandle<A> = {
  promise: Promise<A>;
  cancel: () => void;
};

export type Runtime<Env> = {
  env: Env;
  run: <A>(effect: Effect<Env, A>) => RunHandle<A>;
};

export type HttpClient = {
  getJson: <A>(url: string, init?: RequestInit) => Promise<A>;
};

export type Clock = {
  nowMs: () => number;
  nowIso: () => string;
};

export type Logger = {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

export type UiSink<Update> = {
  apply: (update: Update) => void;
};

export const Effect = {
  of<Env, A>(value: A): Effect<Env, A> {
    return async () => value;
  },
  map<Env, A, B>(effect: Effect<Env, A>, f: (value: A) => B): Effect<Env, B> {
    return async (env, signal) => f(await effect(env, signal));
  },
  chain<Env, A, B>(effect: Effect<Env, A>, f: (value: A) => Effect<Env, B>): Effect<Env, B> {
    return async (env, signal) => f(await effect(env, signal))(env, signal);
  },
  tap<Env, A>(effect: Effect<Env, A>, f: (value: A) => Effect<Env, unknown>): Effect<Env, A> {
    return Effect.chain(effect, (value) => Effect.map(f(value), () => value));
  },
  sleep<Env>(ms: number): Effect<Env, void> {
    return (_env, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const id = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(id);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
  retry<Env, A>(
    effect: Effect<Env, A>,
    options: { retries: number; delayMs?: number }
  ): Effect<Env, A> {
    const { retries, delayMs = 0 } = options;
    return async (env, signal) => {
      let attempt = 0;
      while (!signal.aborted) {
        try {
          return await effect(env, signal);
        } catch (err) {
          if (attempt >= retries) throw err;
          attempt += 1;
          if (delayMs > 0) {
            await Effect.sleep<Env>(delayMs)(env, signal);
          }
        }
      }
      throw new Error("Cancelled");
    };
  }
};

export function createRuntime<Env>(env: Env): Runtime<Env> {
  return {
    env,
    run<A>(effect: Effect<Env, A>): RunHandle<A> {
      const controller = new AbortController();
      const promise = effect(env, controller.signal);
      return {
        promise,
        cancel: () => controller.abort()
      };
    }
  };
}

export function createHttpClient(): HttpClient {
  return {
    async getJson<A>(url: string, init?: RequestInit): Promise<A> {
      const response = await fetch(url, {
        cache: "no-store",
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json() as Promise<A>;
    }
  };
}

export function createClock(): Clock {
  return {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString()
  };
}

export function createLogger(): Logger {
  return {
    info: (message, meta) => console.log(message, meta ?? ""),
    warn: (message, meta) => console.warn(message, meta ?? ""),
    error: (message, meta) => console.error(message, meta ?? "")
  };
}
