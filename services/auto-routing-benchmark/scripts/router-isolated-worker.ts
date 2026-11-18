import app, {
  AutoRoutingDecisionCacheDO as RealDecisionCacheDO,
  AutoRoutingModeConfigDO as RealModeConfigDO,
} from '../../auto-routing/src/index';

const ISOLATION_VIOLATION_HEADER = 'x-benchmark-isolation-violations';

type RouterEnv = Env;
type LocalRouterEnv = RouterEnv & { BENCHMARK_INTERNAL_TOKEN: string };

const syntheticSecretNames: Record<string, true> = {
  OPENROUTER_API_KEY: true,
  O11Y_CF_AE_API_TOKEN: true,
  NEXTAUTH_SECRET: true,
  AUTO_ROUTING_DECISION_SECRET: true,
  UPSTASH_REDIS_REST_URL: true,
  UPSTASH_REDIS_REST_TOKEN: true,
};

function violation(violations: string[], binding: string): Error {
  violations.push(binding);
  return new Error(`Benchmark isolation forbids ${binding}`);
}

// The real code reads secrets only through SecretsStore getters; return synthetic values so no
// credential exists inside the Worker. Bindings that reach the database or the benchmark origin
// are traps: a decision that touches them is reported, never silently degraded.
function isolatedEnv(env: LocalRouterEnv, violations: string[]): RouterEnv {
  return new Proxy(env, {
    get(target, property) {
      if (property === 'HYPERDRIVE') throw violation(violations, 'HYPERDRIVE');
      if (property === 'BENCHMARK_SERVICE') {
        return {
          fetch: async () => {
            throw violation(violations, 'BENCHMARK_SERVICE');
          },
        };
      }
      if (property === 'INTERNAL_API_SECRET_PROD') {
        return { get: async () => target.BENCHMARK_INTERNAL_TOKEN };
      }
      if (typeof property === 'string' && Object.hasOwn(syntheticSecretNames, property)) {
        return { get: async () => `benchmark-synthetic-${property}` };
      }
      const value: unknown = Reflect.get(target, property);
      return value;
    },
  });
}

export class AutoRoutingDecisionCacheDO extends RealDecisionCacheDO {
  constructor(ctx: DurableObjectState, env: LocalRouterEnv) {
    super(ctx, isolatedEnv(env, []));
  }
}

export class AutoRoutingModeConfigDO extends RealModeConfigDO {
  constructor(ctx: DurableObjectState, env: LocalRouterEnv) {
    super(ctx, isolatedEnv(env, []));
  }
}

export default {
  async fetch(request: Request, env: LocalRouterEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const allowed =
      url.search === '' &&
      ((request.method === 'POST' && url.pathname === '/decide') ||
        (request.method === 'GET' && url.pathname === '/health'));
    if (!allowed) return new Response('Not found', { status: 404 });

    const violations: string[] = [];
    const pending: Promise<unknown>[] = [];
    const executionCtx = new Proxy(ctx, {
      get(target, property) {
        if (property === 'waitUntil') {
          return (promise: Promise<unknown>) => {
            pending.push(promise);
            target.waitUntil(promise);
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const response = await app.fetch(request, isolatedEnv(env, violations), executionCtx);
    // Speculative and background classifications are paid calls. Their broker settlements must
    // finish before the run proceeds, or a bill could land after the run is closed.
    for (let start = 0; start < pending.length;) {
      const batch = pending.slice(start);
      start = pending.length;
      await Promise.allSettled(batch);
    }
    const tagged = new Response(response.body, response);
    if (violations.length > 0) {
      tagged.headers.set(ISOLATION_VIOLATION_HEADER, JSON.stringify(violations));
    }
    return tagged;
  },
} satisfies ExportedHandler<LocalRouterEnv>;
