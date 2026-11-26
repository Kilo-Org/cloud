import { WorkerEntrypoint } from 'cloudflare:workers';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import worker from './index';
import { serviceClaims, signToken } from './sts-canary.test-fixture';

/**
 * Test-only build for sts-canary.runtime.test.ts; never deployed. It is usage-ingest itself plus a
 * `SecretsBroker` stand-in that its STS binding points at, so the canary mints over a real RPC
 * call. The stand-in signs as STS does, with a key the test generated and passes as a var.
 */
type FixtureEnv = {
  STS_URL: string;
  STS_ENVIRONMENT: string;
  TEST_SIGNING_JWK: string;
  TEST_SIGNING_KID: string;
};

export class SecretsBroker extends WorkerEntrypoint<FixtureEnv> {
  async mintTokens(request: MintRequest): Promise<MintResult> {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(this.env.TEST_SIGNING_JWK) as JsonWebKey,
      { name: 'Ed25519' },
      false,
      ['sign']
    );
    const signer = { kid: this.env.TEST_SIGNING_KID, privateKey };
    const tokens = await Promise.all(
      request.tokens.map(async ({ audience, scope }) => {
        const claims = serviceClaims({
          issuer: this.env.STS_URL,
          workload: 'usage-ingest',
          audience,
          scope,
          environment: this.env.STS_ENVIRONMENT,
        });
        return {
          status: 'issued' as const,
          audience,
          scope,
          token: await signToken(signer, claims),
          jti: String(claims.jti),
          expiresAt: Number(claims.exp),
        };
      })
    );
    return { status: 'ok', tokens };
  }
}

export default worker;
