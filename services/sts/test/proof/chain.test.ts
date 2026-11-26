import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../proof/vercel-exchange/api/chain';

// The chain check of `api/chain.ts` against a stand-in for the exchange at oidc.vercel.com: only a
// definitive refusal of the second hop counts as Vercel refusing to chain.

const SECRET = 'proof-key-'.padEnd(40, 'x');

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const BASE_TOKEN = unsignedJwt({ owner: 'kilocode', exp: 1_795_656_000 });

/** The exchange answers these in order, then 500. */
function exchangeAnswers(...answers: Response[]): void {
  vi.stubGlobal('fetch', async () => answers.shift() ?? new Response('', { status: 500 }));
}

async function runChain(): Promise<unknown> {
  const request = new Request('https://proof.test/api/chain', {
    method: 'POST',
    headers: { 'x-proof-key': SECRET, 'x-vercel-oidc-token': BASE_TOKEN },
  });
  return await (await POST(request)).json();
}

beforeEach(() => {
  vi.stubEnv('PROOF_SHARED_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chain check', () => {
  it('is inconclusive, not a refusal, when the first hop issues no token', async () => {
    exchangeAnswers(Response.json({ error: 'unavailable' }, { status: 503 }));
    expect(await runChain()).toMatchObject({
      chained: null,
      vercelRefusedChain: false,
      chainedRateLimited: false,
      chainInconclusive: true,
    });
  });

  it('counts a 401 on the second hop as Vercel refusing the chain', async () => {
    exchangeAnswers(
      Response.json({ token: unsignedJwt({ owner: 'kilocode', aud: 'https://example.invalid' }) }),
      Response.json({ error: 'Token has already been exchanged' }, { status: 401 })
    );
    expect(await runChain()).toMatchObject({
      chained: { status: 401 },
      vercelRefusedChain: true,
      chainInconclusive: false,
    });
  });

  it('is inconclusive on a 5xx or a 429 from the second hop', async () => {
    for (const status of [503, 429]) {
      exchangeAnswers(
        Response.json({ token: unsignedJwt({ owner: 'kilocode' }) }),
        Response.json({ error: 'nope' }, { status })
      );
      expect(await runChain()).toMatchObject({
        vercelRefusedChain: false,
        chainedRateLimited: status === 429,
        chainInconclusive: true,
      });
    }
  });
});
