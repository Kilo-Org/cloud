import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_ISSUER,
  verifyRuntimeProxyAttestation,
} from './runtime-proxy-attestation.js';
import { sha256Hex } from './sha256.js';

const secret = 'runtime-proxy-attestation-secret';
const now = new Date('2026-01-01T00:00:00.000Z');
const input = {
  secret,
  audience: 'kilo-api' as const,
  userId: 'usr_123',
  authorizationId: '11111111-1111-4111-8111-111111111111',
  resourceId: 'agent_123',
  bearer: 'exact-runtime-bearer',
  now,
};

describe('runtime proxy attestation', () => {
  it('binds a short-lived proof to the exact bearer and runtime identity', async () => {
    const proof = await issueRuntimeProxyAttestation(input);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: proof, now })).resolves.toBe(
      true
    );
  });

  it.each([
    ['wrong bearer', { bearer: 'other-bearer' }],
    ['wrong user', { userId: 'usr_other' }],
    ['wrong authorization', { authorizationId: '22222222-2222-4222-8222-222222222222' }],
    ['wrong resource', { resourceId: 'agent_other' }],
    ['wrong audience', { audience: 'kilo-gateway' as const }],
  ])('rejects a proof with a %s binding', async (_name, changed) => {
    const proof = await issueRuntimeProxyAttestation(input);
    await expect(
      verifyRuntimeProxyAttestation({ ...input, ...changed, value: proof, now })
    ).resolves.toBe(false);
  });

  it('rejects forged and expired proofs', async () => {
    const forged = await new SignJWT({
      ...input,
      version: 1,
      type: 'cloud-agent-next-runtime-proxy',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('kilocode-runtime-proxy')
      .setAudience('kilo-api')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 30)
      .sign(new TextEncoder().encode('wrong-secret'));
    const proof = await issueRuntimeProxyAttestation(input);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: forged, now })).resolves.toBe(
      false
    );
    await expect(
      verifyRuntimeProxyAttestation({
        ...input,
        value: proof,
        now: new Date(now.getTime() + 31_000),
      })
    ).resolves.toBe(false);
  });

  it('rejects a proof from another issuer and accepts the runtime proxy issuer', async () => {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const signWithIssuer = async (issuer: string): Promise<string> =>
      new SignJWT({
        type: 'cloud-agent-next-runtime-proxy',
        version: 1,
        userId: input.userId,
        authorizationId: input.authorizationId,
        resourceId: input.resourceId,
        bearerDigest: await sha256Hex(input.bearer),
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('kilo-api')
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 30)
        .sign(new TextEncoder().encode(secret));

    const foreignIssuer = await signWithIssuer('another-issuer');
    await expect(
      verifyRuntimeProxyAttestation({ ...input, value: foreignIssuer, now })
    ).resolves.toBe(false);

    const control = await signWithIssuer(RUNTIME_PROXY_ATTESTATION_ISSUER);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: control, now })).resolves.toBe(
      true
    );
  });
});
