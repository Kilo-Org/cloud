import { describe, expect, it, vi } from 'vitest';
import { grant, logicalId, time } from './test-fixtures.js';
import {
  admitScopedScmRequest,
  type ScopedScmGrant,
  type ScopedScmAdmissionContext,
  type ScopedScmAdmissionDependencies,
} from './scoped-admission.js';

type BuildGrant = ScopedScmGrant & { buildId: string };
function fixture() {
  const session = grant();
  const build: BuildGrant = {
    buildId: '11111111-1111-4111-8111-111111111111',
    sandboxId: logicalId,
    provider: 'aws-ec2',
    userId: session.userId,
    orgId: session.orgId,
    outboundContainerId: session.outboundContainerId,
    repository: session.repository,
    scm: session.scm,
    preparedAt: time - 1000,
    expiresAt: time + 60_000,
  };
  const context: ScopedScmAdmissionContext<BuildGrant> = {
    sandboxId: logicalId,
    ownerId: build.userId,
    organizationId: build.orgId,
    provider: 'aws-ec2',
    allocation: { active: true, allocationId: 'allocation-build', providerRef: 'physical-build' },
    outboundContainerId: build.outboundContainerId ?? null,
    containmentEnabled: true,
    identityBinding: 'verified-build-identity',
    available: true,
    grants: [build],
    liveMemberIds: [build.buildId],
  };
  const resolve = vi.fn<ScopedScmAdmissionDependencies<BuildGrant>['resolve']>(
    async ({ grant: current }) => ({
      grant: {
        ...current,
        scm: {
          ...current.scm!,
          capability: { ...current.scm!.capability!, credential: 'kgh2.renewed' },
        },
      },
      credential: 'kgh2.renewed',
    })
  );
  const persist = vi.fn();
  const deps: ScopedScmAdmissionDependencies<BuildGrant> = {
    serial: async operation => operation(),
    readContext: async () => structuredClone(context),
    authenticate: async () => ({ ok: true, isCurrent: () => true }),
    memberIds: value => [value.buildId],
    resolve,
    persist,
    now: () => time,
  };
  const request = {
    target: { url: build.scm!.gitUrl, method: 'GET' },
    authorization: { authorization: `Bearer ${build.scm!.alias}` },
  };
  return { build, context, request, deps, resolve, persist };
}
describe('SCM-only build authority', () => {
  it('admits and renews a build without session membership, model credentials or runtime handles', async () => {
    const f = fixture();
    expect(f.build).not.toHaveProperty('kilo');
    expect(f.build).not.toHaveProperty('members');
    expect(await admitScopedScmRequest(f.request, f.deps)).toMatchObject({
      ok: true,
      authority: {
        type: 'managed',
        provider: 'github',
        capability: 'kgh2.renewed',
        outboundContainerId: f.build.outboundContainerId,
      },
    });
    expect(f.persist).toHaveBeenCalledOnce();
  });
  it.each(['cancelled', 'replacement', 'revoked-owner', 'expired'])(
    'removes authority after %s during renewal',
    async change => {
      const f = fixture();
      const resolve = f.resolve.getMockImplementation()!;
      f.resolve.mockImplementationOnce(async input => {
        const value = await resolve(input);
        if (change === 'cancelled') f.context.allocation.active = false;
        if (change === 'replacement') f.context.allocation.allocationId = 'replacement';
        if (change === 'revoked-owner') f.context.ownerId = null;
        if (change === 'expired') f.context.liveMemberIds = [];
        return value;
      });
      expect(await admitScopedScmRequest(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.persist).not.toHaveBeenCalled();
    }
  );
});
