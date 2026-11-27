import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_ISSUER,
  RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH,
  verifyRuntimeProxyAttestation,
} from './runtime-proxy-attestation.js';
import { sha256Hex } from './sha256.js';
import * as kiloTokenVerification from './kilo-token-verification';

vi.mock('./kilo-token-verification', async importOriginal => {
  const actual = await importOriginal<typeof kiloTokenVerification>();
  return { ...actual, verifyKiloTokenSignature: vi.fn(actual.verifyKiloTokenSignature) };
});

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

  it('checks the exported length bound before the token verifier runs', async () => {
    const verifyTokenSignature = vi.mocked(kiloTokenVerification.verifyKiloTokenSignature);
    verifyTokenSignature.mockClear();

    const oversized = 'a'.repeat(RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH + 1);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: oversized, now })).resolves.toBe(
      false
    );
    expect(verifyTokenSignature).not.toHaveBeenCalled();

    verifyTokenSignature.mockClear();
    const atMaximum = 'a'.repeat(RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: atMaximum, now })).resolves.toBe(
      false
    );
    expect(verifyTokenSignature).toHaveBeenCalledTimes(1);

    verifyTokenSignature.mockClear();
    const proof = await issueRuntimeProxyAttestation(input);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: proof, now })).resolves.toBe(
      true
    );

    const oversizedSubject = { ...input, userId: 'u'.repeat(5000) };
    const oversizedProof = await issueRuntimeProxyAttestation(oversizedSubject);
    expect(oversizedProof.length).toBeGreaterThan(RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH);
    await expect(
      verifyRuntimeProxyAttestation({ ...oversizedSubject, value: oversizedProof, now })
    ).resolves.toBe(false);
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
    const proof = await issueRuntimeProxyAttestation({
      ...input,
      now: new Date(now.getTime() - 90_000),
    });
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

  it('accepts signed lifetimes up to 120 seconds without extending expiration', async () => {
    const claims = decodeJwt(await issueRuntimeProxyAttestation(input));
    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(claims.exp).toBe(issuedAt + 120);

    const signWithLifetime = (seconds: number) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setExpirationTime(issuedAt + seconds)
        .sign(new TextEncoder().encode(secret));

    const proof = await signWithLifetime(120);
    await expect(
      verifyRuntimeProxyAttestation({
        ...input,
        value: proof,
        now: new Date(now.getTime() + 31_000),
      })
    ).resolves.toBe(true);
    await expect(
      verifyRuntimeProxyAttestation({
        ...input,
        value: proof,
        now: new Date(now.getTime() + 121_000),
      })
    ).resolves.toBe(false);

    const overlong = await signWithLifetime(121);
    await expect(verifyRuntimeProxyAttestation({ ...input, value: overlong })).resolves.toBe(false);
  });
});
