import { decodeAuditBatch, type MintResult } from '@kilocode/sts-contracts';
import type { E2eSecretsBroker } from './sts';

/**
 * Test-only probe Worker for the local end-to-end check; never deployed. `STS` binds the test
 * build's broker entrypoint with `props.caller`, as a consumer binds `SecretsBroker`; `STS_HTTP`
 * forwards the probe's own non-probe paths to STS's HTTP routes, so the node script reaches both
 * Workers on one port. It also consumes the audit queue STS produces to and keeps every event.
 */
type ProbeEnv = { STS: Service<E2eSecretsBroker>; STS_HTTP: Fetcher };

type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };

/** Events this isolate consumed, for `GET /probe/audit`. */
const seen: SeenEvent[] = [];

async function mint(env: ProbeEnv, audiences: string[]): Promise<Response> {
  const result: MintResult = await env.STS.mintTokens({
    tokens: audiences.map(audience => ({ audience, scope: `${audience}:probe.read` })),
  });
  return Response.json(result);
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/probe/mint') {
      return await mint(env, (url.searchParams.get('audiences') ?? '').split(','));
    }
    if (url.pathname === '/probe/audit') return Response.json(seen);
    return await env.STS_HTTP.fetch(request);
  },

  async queue(batch: MessageBatch<ArrayBuffer>): Promise<void> {
    for (const message of batch.messages) {
      const decoded = await decodeAuditBatch(message.body);
      for (const event of decoded.events) {
        seen.push({ stream: decoded.stream, type: event.type, attributes: event.data.attributes });
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<ProbeEnv, ArrayBuffer>;
