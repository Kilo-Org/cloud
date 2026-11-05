import { exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';

jest.mock('@kilocode/web-shared/lib/admin/admin-access-log', () => ({
  recordKiloAdminElevationForRequest: jest.fn(async () => undefined),
  serviceTarget: (id: string) => `service:${id}`,
}));

import { recordKiloAdminElevationForRequest } from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  GASTOWN_ADMIN_AUDIENCE,
  WASTELAND_ADMIN_AUDIENCE,
} from '@kilocode/worker-utils/worker-admin-capability';
import {
  WorkerAdminCapabilityIssuanceError,
  issueWorkerAdminCapability,
} from './capability-issuer';

const user = {
  id: 'user-1',
  api_token_pepper: 'pepper-1',
  google_user_email: 'admin@example.com',
  is_admin: true,
  is_super_admin: false,
};

let publicJwk: JWK;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid: 'wac-test' };
  publicJwk = { ...(await exportJWK(publicKey)), kid: 'wac-test' };
  process.env.WORKER_ADMIN_CAPABILITY_PRIVATE_JWK = JSON.stringify(privateJwk);
  process.env.WORKER_ADMIN_CAPABILITY_ISSUANCE = 'on';
});

afterAll(() => {
  delete process.env.WORKER_ADMIN_CAPABILITY_PRIVATE_JWK;
  delete process.env.WORKER_ADMIN_CAPABILITY_ISSUANCE;
});

describe('issueWorkerAdminCapability', () => {
  it('mints a five-minute capability scoped to one town', async () => {
    const issued = await issueWorkerAdminCapability({
      user,
      audience: GASTOWN_ADMIN_AUDIENCE,
      target: { kind: 'town', id: 'town-1' },
      actions: ['trpc:gastown.getTown'],
      now: new Date('2026-01-01T00:00:00Z'),
    });

    const verified = await jwtVerify(issued.capability, await importJWK(publicJwk, 'ES256'), {
      audience: GASTOWN_ADMIN_AUDIENCE,
      issuer: 'kilo-web',
      currentDate: new Date('2026-01-01T00:01:00Z'),
    });
    expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', kid: 'wac-test' });
    expect(verified.payload).toMatchObject({
      sub: 'user-1',
      jti: issued.jti,
      cap: { v: 1, actions: ['trpc:gastown.getTown'], targets: [{ kind: 'town', id: 'town-1' }] },
    });
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(300);
    expect(issued.capabilityExpiresAt).toBe('2026-01-01T00:05:00.000Z');
    expect(recordKiloAdminElevationForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'worker_capability_mint', issuanceId: issued.jti })
    );
  });

  it('defaults to read actions for the target kind', async () => {
    const issued = await issueWorkerAdminCapability({
      user,
      audience: WASTELAND_ADMIN_AUDIENCE,
      target: { kind: 'wasteland', id: 'wasteland-1' },
    });
    expect(issued.actions).toContain('trpc:wasteland.getWasteland');
    expect(issued.actions).not.toContain('trpc:wasteland.adminListWastelands');
  });

  it('refuses actions that are not allowlisted for the target kind', async () => {
    await expect(
      issueWorkerAdminCapability({
        user,
        audience: GASTOWN_ADMIN_AUDIENCE,
        target: { kind: 'town', id: 'town-1' },
        actions: ['trpc:gastown.createPtySession'],
      })
    ).rejects.toMatchObject({ status: 403, code: 'action_not_allowed' });
  });

  it('never mints a service target other than the audience service', async () => {
    await expect(
      issueWorkerAdminCapability({
        user,
        audience: WASTELAND_ADMIN_AUDIENCE,
        target: { kind: 'service', id: 'gastown' },
        actions: ['trpc:wasteland.adminListWastelands'],
      })
    ).rejects.toMatchObject({ status: 403, code: 'service_target_mismatch' });
  });

  it('caps a requested TTL at five minutes', async () => {
    const issued = await issueWorkerAdminCapability({
      user,
      audience: GASTOWN_ADMIN_AUDIENCE,
      target: { kind: 'town', id: 'town-1' },
      actions: ['trpc:gastown.getTown'],
      ttlSeconds: 10_000,
    });
    const verified = await jwtVerify(issued.capability, await importJWK(publicJwk, 'ES256'), {
      audience: GASTOWN_ADMIN_AUDIENCE,
      issuer: 'kilo-web',
    });
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(300);
  });

  it('is disabled unless the flag is on', async () => {
    process.env.WORKER_ADMIN_CAPABILITY_ISSUANCE = 'off';
    await expect(
      issueWorkerAdminCapability({
        user,
        audience: GASTOWN_ADMIN_AUDIENCE,
        target: { kind: 'town', id: 'town-1' },
        actions: ['trpc:gastown.getTown'],
      })
    ).rejects.toBeInstanceOf(WorkerAdminCapabilityIssuanceError);
    process.env.WORKER_ADMIN_CAPABILITY_ISSUANCE = 'on';
  });

  it('fails closed when the signing key is missing', async () => {
    const saved = process.env.WORKER_ADMIN_CAPABILITY_PRIVATE_JWK;
    delete process.env.WORKER_ADMIN_CAPABILITY_PRIVATE_JWK;
    await expect(
      issueWorkerAdminCapability({
        user,
        audience: GASTOWN_ADMIN_AUDIENCE,
        target: { kind: 'town', id: 'town-1' },
        actions: ['trpc:gastown.getTown'],
      })
    ).rejects.toMatchObject({ status: 503, code: 'signing_key_unavailable' });
    process.env.WORKER_ADMIN_CAPABILITY_PRIVATE_JWK = saved;
  });
});
