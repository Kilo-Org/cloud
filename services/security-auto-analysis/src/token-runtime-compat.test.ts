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
        expiresInSeconds: 157_680_000,
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
        organizationId,
      });
      const authenticate = (token: string, audience: string) =>
        verifyKiloBearerAgainstCurrentPepper({
          token,
          nextAuthSecret: secret,
          connectionString: 'unused',
          resourceAudience: { audience, mode: 'allow-legacy' },
          getUserPepper: async () => ({ pepper: principal.apiTokenPepper, blockedReason: null }),
        });
      await expect(authenticate(legacy.token, 'kilo-api')).resolves.toEqual({ userId: user.id });
      await expect(authenticate(control, 'cloud-agent-next')).resolves.toEqual({ userId: user.id });
      for (const audience of ['kilo-api', 'kilo-gateway', 'session-ingest']) {
        const auth = await verifyKiloTokenForPolicy(runtime.token, secret, {
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
        verifyKiloTokenForPolicy(runtime.token, secret, {
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
      const tokens = [
        [await generateControlToken(user, secret, 'production', flag), 'cloud-agent-next'],
        [await generateTriageToken(user, secret, 'production', flag), 'kilo-gateway'],
        [await generateInternalServiceToken(user.id, secret, flag), 'session-ingest'],
      ];
      for (const [token, audience] of tokens) {
        const auth = await verifyKiloTokenForPolicy(token, secret, {
          audience,
          mode: 'allow-legacy',
        });
        expect(auth.claims.exp - auth.claims.iat).toBe(3600);
        if (flag === true || flag === 'true') {
          await expect(verifyKiloToken(token, secret)).rejects.toThrow('audience');
          for (const other of [
            'cloud-agent-next',
            'kilo-gateway',
            'session-ingest',
            'kilo-api',
          ].filter(value => value !== audience)) {
            await expect(
              verifyKiloTokenForPolicy(token, secret, { audience: other, mode: 'allow-legacy' })
            ).rejects.toThrow('audience');
          }
        } else {
          await expect(verifyKiloToken(token, secret)).resolves.toHaveProperty(
            'kiloUserId',
            user.id
          );
        }
      }
    }
  );
});
