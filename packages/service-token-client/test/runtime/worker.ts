import { WorkerEntrypoint } from 'cloudflare:workers';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import {
  createWorkerServiceTokens,
  type MintBinding,
  type ServiceTokens,
  type ServiceTokensExecutionContext,
} from '../../src/index';

/**
 * Test-only Worker for runtime.test.ts. Each request reads one token through one isolate-scoped
 * client, as a consumer holds it. The STS binding points at this Worker's own `SecretsBroker`, a
 * stand-in that answers after `delayMs`, so a mint is a real RPC call in its own context.
 */
type Env = { STS: MintBinding };

let delayMs = 0;
const calls: { tokens: number; answeredAt: number | null }[] = [];

export class SecretsBroker extends WorkerEntrypoint<Env> {
  async mintTokens(request: MintRequest): Promise<MintResult> {
    const call = { tokens: request.tokens.length, answeredAt: null as number | null };
    calls.push(call);
    const answer = Promise.withResolvers<void>();
    setTimeout(answer.resolve, delayMs);
    await answer.promise;
    call.answeredAt = Date.now();
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    return {
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }) => ({
        status: 'issued',
        audience,
        scope,
        token: `${scope}-token`,
        jti: crypto.randomUUID(),
        expiresAt,
      })),
    };
  }
}

let tokens: ServiceTokens | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ServiceTokensExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/plan') {
      delayMs = Number(url.searchParams.get('delayMs'));
      calls.length = 0;
      return new Response('ok');
    }
    if (url.pathname === '/calls') return Response.json(calls);
    const client = (tokens ??= createWorkerServiceTokens(env.STS));
    // `audiences` is a comma list; one request reads them together, as a handler does.
    const audiences = (url.searchParams.get('audiences') ?? 'web').split(',');
    try {
      const values = await Promise.all(
        audiences.map(audience => client.get({ audience, scope: `${audience}:sts.canary` }, ctx))
      );
      return Response.json({ outcome: 'read', tokens: values, at: Date.now() });
    } catch (error) {
      return Response.json({ outcome: 'error', message: String(error) });
    }
  },
};
