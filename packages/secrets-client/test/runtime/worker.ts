import type { BundleResult } from '@kilocode/sts-contracts';
import { createWorkerSecrets, type SecretsExecutionContext } from '../../src/index';

/**
 * Test-only Worker for runtime.test.ts. Each request reads one secret through one isolate-scoped
 * client, as o11y and the audit relay hold theirs. The binding is a stand-in whose answers the
 * test scripts; it waits on a timer, and workerd ties a timer to the request that set it, so the
 * answer to a call made for a request that has ended never arrives, as with a real binding call.
 */
type Step = { result: BundleResult; delayMs: number };
type Call = {
  ifNoneMatch: string | null;
  status: BundleResult['status'];
  answeredAt: number | null;
};

let plan: Step[] = [];
const calls: Call[] = [];

// The client reads Date.now(); moving it lets the test age the held bundle without waiting.
const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;

const secrets = createWorkerSecrets({
  async getBundle(request) {
    const step = plan.shift();
    if (step === undefined) throw new Error('the test planned no answer for this call');
    const call: Call = {
      ifNoneMatch: request.ifNoneMatch ?? null,
      status: step.result.status,
      answeredAt: null,
    };
    calls.push(call);
    const answer = Promise.withResolvers<void>();
    setTimeout(answer.resolve, step.delayMs);
    await answer.promise;
    call.answeredAt = Date.now();
    return step.result;
  },
});

export default {
  async fetch(request: Request, _env: unknown, ctx: SecretsExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/plan':
        plan = (await request.json()) as Step[];
        calls.length = 0;
        return new Response('ok');
      case '/calls':
        return Response.json(calls);
      case '/clock':
        clockOffsetMs += Number(url.searchParams.get('advanceMs'));
        return new Response('ok');
    }
    const read = secrets.get('O11Y_CF_AE_API_TOKEN', ctx);
    const giveUpMs = url.searchParams.get('giveUpMs');
    if (giveUpMs !== null) {
      // Ends the request after giveUpMs without waiting for the read.
      read.catch(() => {});
      const gaveUp = Promise.withResolvers<string>();
      setTimeout(() => gaveUp.resolve('gave_up'), Number(giveUpMs));
      return Response.json({
        outcome: await Promise.race([read.then(() => 'read'), gaveUp.promise]),
      });
    }
    try {
      return Response.json({ outcome: 'read', value: await read, at: Date.now() });
    } catch (err) {
      return Response.json({ outcome: 'error', message: String(err), at: Date.now() });
    }
  },
};
