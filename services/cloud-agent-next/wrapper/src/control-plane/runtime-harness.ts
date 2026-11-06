import { z } from 'zod';
import { selectedRuntimeCli } from '../../../src/shared/runtime-distribution.js';
import { fetchKiloServer, type KiloServer } from '../kilo-server-auth.js';
import { createKilo2Harness } from './kilo2-harness.js';
import { createKilo2EventFeed } from './kilo2-event-feed.js';
import { createKiloHarness } from './kilo-harness.js';
import { createKiloEventFeed } from './kilo-event-feed.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import type { KiloHarnessOptions } from './kilo-harness.js';
import { createKilo2Lifecycle } from './kilo2-lifecycle.js';

/** Only the trusted wrapper environment selects a backend, never route/profile env. */
export function runtimeHarness(env: Record<string, string | undefined> = process.env) {
  const kind = z.enum(['kilo', 'kilo2']).parse(env.KILO_RUNTIME_HARNESS ?? 'kilo');
  let lifecycle = createKilo2Lifecycle();
  return kind === 'kilo2'
    ? {
        kind,
        username: 'opencode',
        dataDirectory: 'kilo2',
        cli: env.KILO_RUNTIME_CLI_PATH ? selectedRuntimeCli(env) : 'kilo2',
        ready: /^server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/m,
        create(options: KiloHarnessOptions) {
          lifecycle = createKilo2Lifecycle();
          return createKilo2Harness({ ...options, lifecycle });
        },
        feed: createKilo2EventFeed,
        onEvent(event: KiloFeedEvent) {
          if (event.type === 'session.turn.close' && typeof event.properties.sessionID === 'string')
            lifecycle.closed(event.properties.sessionID);
        },
      }
    : {
        kind,
        username: 'kilo',
        dataDirectory: 'kilo',
        cli: selectedRuntimeCli(env),
        ready: /^kilo server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/m,
        create: createKiloHarness,
        feed: createKiloEventFeed,
        onEvent: undefined,
      };
}

/** Preserve generated Cloud permissions and profiles through v2's supported v1 config reader. */
export function kilo2RuntimeEnvironment(env: Record<string, string>): Record<string, string> {
  const config = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(env.KILO_CONFIG_CONTENT ?? '{}'));
  delete config.indexing;
  const provider = z
    .object({
      kilo: z
        .object({ options: z.object({ baseURL: z.string().optional() }).passthrough() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .safeParse(config.provider);
  const gateway = provider.success ? provider.data.kilo?.options.baseURL : undefined;
  const nativeGateway = gateway
    ? /\/api\/(?:openrouter|gateway)\/?$/.test(gateway)
      ? gateway.replace(/\/+$/, '')
      : `${gateway.replace(/\/api\/?$/, '').replace(/\/+$/, '')}/api/openrouter`
    : undefined;
  if (nativeGateway && provider.success && provider.data.kilo) {
    config.provider = {
      ...provider.data,
      kilo: {
        ...provider.data.kilo,
        options: { ...provider.data.kilo.options, baseURL: nativeGateway },
      },
    };
  }
  return {
    ...env,
    KILO_CONFIG_CONTENT: JSON.stringify(config),
    ...(nativeGateway ? { KILO_AI_GATEWAY_URL: nativeGateway } : {}),
  };
}

export async function probeKilo2Health(server: KiloServer, signal: AbortSignal): Promise<boolean> {
  const response = await fetchKiloServer(server, '/api/info', { signal });
  if (!response.ok) return false;
  return z
    .object({ version: z.string(), pid: z.number().int().nonnegative() })
    .safeParse(await response.json()).success;
}
