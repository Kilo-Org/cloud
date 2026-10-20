import { DurableObject } from 'cloudflare:workers';
import { getClient } from '@sentry/cloudflare';
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import { instrumentCloudAgentDurableObject } from '../../../src/sentry.js';
import type { Env } from '../../../src/types.js';

export class SentryDurableObjectProbe extends DurableObject<Env> {
  #name: string | undefined;
  #constructorClient = getClient();
  #releaseFailure?: () => void;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = ctx.id.name;
    void ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.put('constructed', true);
    });
  }

  async snapshot() {
    await this.ctx.storage.put('rpc-value', 42);
    return {
      name: this.#name,
      constructed: await this.ctx.storage.get<boolean>('constructed'),
      value: await this.ctx.storage.get<number>('rpc-value'),
      instrumentedContext: 'originalStorage' in this.ctx,
      hasSentryClient: getClient() !== undefined,
      sentryClientUnchanged: getClient() === this.#constructorClient,
    };
  }

  roundTrip(value: number): number {
    return value;
  }

  rpcSyncFailure(): void {
    throw new RangeError('private-sync-rpc-failure');
  }

  async rpcFailure(code?: TRPC_ERROR_CODE_KEY): Promise<void> {
    await this.ctx.storage.get('constructed');
    if (code) throw new TRPCError({ code, message: 'private-trpc-failure' });
    throw new TypeError('private-async-rpc-failure');
  }

  async heldFailure(kind: 'type' | 'range' | 'syntax'): Promise<void> {
    await new Promise<void>(resolve => {
      this.#releaseFailure = resolve;
    });
    this.#releaseFailure = undefined;
    if (kind === 'type') throw new TypeError('private-concurrent-session-failure');
    if (kind === 'range') throw new RangeError('private-concurrent-sandbox-failure');
    throw new SyntaxError('private-concurrent-other-session-failure');
  }

  hasHeldFailure(): boolean {
    return this.#releaseFailure !== undefined;
  }

  releaseFailure(): void {
    this.#releaseFailure?.();
  }

  async scheduleAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put('alarm-ran', true);
    throw new Error('private-alarm-failure');
  }

  fetch(): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') {
      socket.send('pong');
      return;
    }
    throw new SyntaxError('private-websocket-failure');
  }
}

function telemetryProbe(component: string) {
  const InstrumentedProbe = instrumentCloudAgentDurableObject(SentryDurableObjectProbe, component);
  return class extends InstrumentedProbe {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, {
        ...env,
        CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
        CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test',
        CF_VERSION_METADATA: { id: 'sentry-worker-test-version' },
      });
    }
  };
}

export const SentrySessionProbe = telemetryProbe('session');
export const SentryLegacySessionProbe = telemetryProbe('legacy-session');
export const SentrySandboxControlProbe = telemetryProbe('sandbox-control');
export const SentrySandboxContainerProbe = telemetryProbe('sandbox-container');

export class SentryDisabledProbe extends instrumentCloudAgentDurableObject(
  SentryDurableObjectProbe,
  'session'
) {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, CLOUD_AGENT_SENTRY_DSN: undefined });
  }
}
