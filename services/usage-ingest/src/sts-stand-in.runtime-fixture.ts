import { WorkerEntrypoint } from 'cloudflare:workers';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';

/**
 * Test-only Worker; never deployed. workerd refuses to start a Worker whose service binding names
 * a service it does not run, so runtime tests that start the committed wrangler.jsonc run this
 * `SecretsBroker` under the bound STS service name (sts-stand-in.test-fixture.ts). It issues the
 * same opaque token for every requested scope, valid for 5 minutes.
 */
export class SecretsBroker extends WorkerEntrypoint<{ STAND_IN_TOKEN: string }> {
  async mintTokens(request: MintRequest): Promise<MintResult> {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    return {
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }, index) => ({
        status: 'issued' as const,
        audience,
        scope,
        token: this.env.STAND_IN_TOKEN,
        jti: `stand-in-${index}`,
        expiresAt,
      })),
    };
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
