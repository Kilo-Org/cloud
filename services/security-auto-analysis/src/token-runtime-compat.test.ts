import { describe, expect, it } from 'vitest';
import { signKiloToken, verifyKiloToken } from '@kilocode/worker-utils';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import {
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  type RuntimeAuthorizationPrincipal,
} from '@kilocode/worker-utils/runtime-authorization';
import { generateControlToken, generateTriageToken, generateInternalServiceToken } from './token';

const secret = 'automation-compat-test-secret';
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verifier = { keys: { legacyHs256Secret: secret }, acceptedIssuers: ['kilo-web'] as const };

describe('automation issuer to runtime compatibility', () => {
  it.each([null, 'current-pepper'])(
    'preserves existing CLI credentials and renews with pepper %s',
    async pepper => {
      const user = { id: 'oauth/test-user', api_token_pepper: pepper };
      let principal: RuntimeAuthorizationPrincipal = {
        id: user.id,
        apiTokenPepper: pepper,
        blockedAt: null,
        blockedReason: null,
        isBot: false,
      };
      const legacy = await signKiloToken({
        userId: user.id,
        pepper,
        secret,
        expiresInSeconds: 30 * 24 * 60 * 60,
      });
      const control = await generateControlToken(user, secret, 'production', true, organizationId);
      const adapters = {
        getPrincipal: async () => principal,
        getMembership: async () => ({
          id: 'membership-1',
          role: 'member',
          organizationDeletedAt: null,
        }),
      };
      const common = { secret, connectionString: 'unused', adapters };
      const runtime = await createRuntimeAuthorization({
        ...common,
        token: control,
        resourceKind: 'cloud-agent-next',
        resourceId: 'session-1',
        environment: 'production',
        organizationId,
      });
      const authenticate = (token: string, audience: string) =>
        verifyKiloBearerAgainstCurrentPepper({
          token,
          keys: { legacyHs256Secret: secret },
          acceptedIssuers: ['kilo-web'],
          connectionString: 'unused',
          resourceAudience: { audience, mode: 'allow-legacy' },
          getUserPepper: async () => ({ pepper: principal.apiTokenPepper, blocked: false }),
        });
      await expect(authenticate(legacy.token, 'kilo-api')).resolves.toEqual({ userId: user.id });
      await expect(authenticate(control, 'cloud-agent-next')).resolves.toEqual({ userId: user.id });
      for (const audience of ['kilo-api', 'kilo-gateway', 'session-ingest']) {
        const auth = await verifyKiloTokenForPolicy(runtime.token, verifier, {
          audience,
          mode: 'required',
        });
        expect(auth.claims).toMatchObject({
          apiTokenPepper: pepper,
          organizationId,
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
        });
        await expect(authenticate(control, audience)).resolves.toBeNull();
      }
      await expect(
        verifyKiloTokenForPolicy(runtime.token, verifier, {
          audience: 'cloud-agent-next',
          mode: 'required',
        })
      ).rejects.toThrow();
      const now = new Date(Date.now() + 61 * 60_000);
      await expect(
        renewRuntimeAuthorization({ ...common, authorization: runtime.authorization, now })
      ).resolves.toHaveProperty('token');
      await expect(
        renewRuntimeAuthorization({
          ...common,
          authorization: runtime.authorization,
          now: new Date(runtime.authorization.delegationExpiresAt),
        })
      ).rejects.toThrow('expired');
      principal = { ...principal, apiTokenPepper: 'rotated-pepper' };
      await expect(authenticate(control, 'cloud-agent-next')).resolves.toBeNull();
      await expect(authenticate(legacy.token, 'kilo-api')).resolves.toBeNull();
      await expect(
        renewRuntimeAuthorization({ ...common, authorization: runtime.authorization })
      ).rejects.toThrow('revoked');
      expect(user.api_token_pepper).toBe(pepper);
    }
  );

  it.each([undefined, false, 'false', true, 'true'])(
    'uses the intended receiver for flag %s',
    async flag => {
      const user = { id: 'oauth/test-user', api_token_pepper: null };
      const modernControl = flag === true || flag === 'true';
      const tokens: [string, string, boolean][] = [
        [
          await generateControlToken(user, secret, 'production', flag),
          'cloud-agent-next',
          modernControl,
        ],
        [
          await generateTriageToken(user, secret, 'production', flag),
          'kilo-gateway',
          modernControl,
        ],
        [await generateInternalServiceToken(user.id, secret), 'session-ingest', true],
      ];
      for (const [token, audience, modern] of tokens) {
        const auth = await verifyKiloTokenForPolicy(token, verifier, {
          audience,
          mode: 'allow-legacy',
        });
        expect(auth.claims.exp - auth.claims.iat).toBe(3600);
        if (modern) {
          await expect(verifyKiloToken(token, verifier)).rejects.toThrow('audience');
          for (const other of [
            'cloud-agent-next',
            'kilo-gateway',
            'session-ingest',
            'kilo-api',
          ].filter(value => value !== audience)) {
            await expect(
              verifyKiloTokenForPolicy(token, verifier, { audience: other, mode: 'allow-legacy' })
            ).rejects.toThrow('audience');
          }
        } else {
          await expect(verifyKiloToken(token, verifier)).resolves.toHaveProperty(
            'kiloUserId',
            user.id
          );
        }
      }
    }
  );
});
