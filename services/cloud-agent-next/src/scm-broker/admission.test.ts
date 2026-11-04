import { describe, expect, it, vi } from 'vitest';
import type { AgentSandboxProvider } from '../types.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import {
  admitScmRequest,
  type ScmAdmissionContext,
  type ScmAdmissionDependencies,
} from './admission.js';
import { grant, logicalId, time } from './test-fixtures.js';

function fixture(
  provider: AgentSandboxProvider,
  purpose: 'github' | 'gitlab' | 'bitbucket' = 'github'
) {
  const scope = grant(purpose);
  scope.provider = provider;
  let context: ScmAdmissionContext = {
    sandboxId: logicalId,
    ownerId: scope.userId,
    provider,
    containmentEnabled: true,
    allocation: { kind: 'starting', allocationId: 'allocation', providerRef: 'physical-ref' },
    outboundContainerId: scope.outboundContainerId ?? null,
    grants: [scope],
    liveSessionIds: scope.members.map(member => member.sessionId),
    organizationId: scope.orgId,
    identityBinding: 'trusted-platform-binding',
    available: true,
  };
  const request = {
    target: { url: scope.scm!.gitUrl, method: 'POST' },
    authorization: { authorization: `Bearer ${scope.scm!.alias}` },
  };
  const resolve = vi.fn<ScmAdmissionDependencies['resolve']>(async ({ grant: current }) => ({
    grant: {
      ...current,
      scm: {
        ...current.scm!,
        capability: {
          ...current.scm!.capability!,
          credential: `${{ github: 'kgh2', gitlab: 'kgl2', bitbucket: 'kbb1' }[purpose]}.renewed`,
          expiresAt: time + 600_000,
        },
      },
    },
    credential: `${{ github: 'kgh2', gitlab: 'kgl2', bitbucket: 'kbb1' }[purpose]}.renewed`,
  }));
  const persist = vi.fn<ScmAdmissionDependencies['persist']>(renewed => {
    context = { ...context, grants: [renewed] };
  });
  const deps: ScmAdmissionDependencies = {
    serial: async operation => operation(),
    readContext: async () => structuredClone(context),
    authenticate: async () => ({ ok: true, isCurrent: () => true }),
    resolve,
    persist,
    now: () => time,
  };
  return { request, deps, context, scope, resolve, persist, current: () => context };
}

describe.each(['cloudflare', 'cloudflare-containers', 'vercel'] as const)(
  '%s shared SCM admission',
  provider => {
    it.each(['github', 'gitlab', 'bitbucket'] as const)(
      'admits %s and persists renewed backing credentials behind the same alias',
      async purpose => {
        const f = fixture(provider, purpose);
        const result = await admitScmRequest(f.request, f.deps);
        expect(result).toMatchObject({
          ok: true,
          authority: {
            type: 'managed',
            provider: purpose,
            outboundContainerId: 'allocation-binding',
          },
        });
        expect(f.current().grants[0].scm?.alias).toBe(f.scope.scm?.alias);
        expect(f.current().grants[0].scm?.capability?.credential).toContain('.renewed');
        expect(f.current().grants[0].scm?.capability?.expiresAt).toBe(time + 600_000);
      }
    );

    it.each([
      'expired',
      'future',
      'owner',
      'sandbox',
      'provider',
      'binding',
      'organization',
      'member',
      'stopped',
      'stopping',
      'uncontained',
      'target',
      'foreign-alias',
      'mixed',
      'raw-capability',
      'malformed-alias',
    ])('denies %s without renewal or persistence', async kind => {
      const f = fixture(provider);
      if (kind === 'expired') f.scope.expiresAt = time;
      if (kind === 'future') f.scope.preparedAt = time + 1;
      if (kind === 'owner') f.scope.userId = 'foreign';
      if (kind === 'sandbox') f.scope.sandboxId = 'sbx-foreign';
      if (kind === 'provider') f.scope.provider = provider === 'vercel' ? 'cloudflare' : 'vercel';
      if (kind === 'binding') f.scope.outboundContainerId = 'foreign';
      if (kind === 'organization') f.scope.orgId = 'foreign';
      if (kind === 'member') f.context.liveSessionIds = [];
      if (kind === 'stopped' || kind === 'stopping') f.context.allocation.kind = kind;
      if (kind === 'uncontained') f.context.containmentEnabled = false;
      if (kind === 'target') f.request.target.url = 'https://foreign.example';
      if (kind === 'foreign-alias')
        f.request.authorization.authorization = `Bearer ${createControlPlaneCredential('sbx-foreign', 'github')}`;
      if (kind === 'mixed')
        Object.assign(f.request.authorization, { privateToken: 'caller-token' });
      if (kind === 'raw-capability') f.request.authorization.authorization = 'Bearer kgh2.raw';
      if (kind === 'malformed-alias') f.request.authorization.authorization = 'Bearer kcp1.bad';
      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
    });

    it.each(['verification', 'renewal'] as const)(
      'rechecks authoritative allocation and grants after asynchronous %s',
      async phase => {
        for (const change of [
          'allocation',
          'provider-ref',
          'owner',
          'configuration',
          'membership',
          'grant',
        ]) {
          const f = fixture(provider);
          function mutate() {
            if (change === 'allocation') f.context.allocation.allocationId = 'replacement';
            if (change === 'provider-ref') f.context.allocation.providerRef = 'replacement';
            if (change === 'owner') f.context.ownerId = 'foreign';
            if (change === 'configuration') f.context.identityBinding = 'replacement';
            if (change === 'membership') f.context.liveSessionIds = [];
            if (change === 'grant') f.scope.expiresAt = time + 1234;
          }
          if (phase === 'verification') {
            f.deps.authenticate = async () => {
              mutate();
              return { ok: true, isCurrent: () => true };
            };
          } else {
            const renew = f.resolve.getMockImplementation()!;
            f.resolve.mockImplementationOnce(async input => {
              const result = await renew(input);
              mutate();
              return result;
            });
          }
          const result = await admitScmRequest(f.request, f.deps);
          // A changed grant before selection remains authoritative and may still be valid.
          if (phase === 'verification' && change === 'grant') {
            expect(result).toMatchObject({ ok: true });
          } else {
            expect(result, `${phase}: ${change}`).toMatchObject({ ok: false });
            expect(f.persist).not.toHaveBeenCalled();
          }
        }
      }
    );

    it('does not grant unmanaged authority after a managed renewal denial', async () => {
      const f = fixture(provider);
      f.resolve.mockResolvedValueOnce(null);
      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({
        ok: false,
        code: 'credential_denied',
      });
      expect(f.persist).not.toHaveBeenCalled();
    });

    it('admits the capability of the additional repository the request URL names', async () => {
      const f = fixture(provider);
      const memberCapability = 'kgh2.member';
      f.scope.additionalRepositories = [
        {
          repository: {
            type: 'github',
            repo: 'acme/other',
            authentication: 'managed',
            allowUserAuthorization: false,
          },
          scm: {
            ...f.scope.scm!,
            gitUrl: 'https://github.com/acme/other.git',
            capability: { ...f.scope.scm!.capability!, credential: memberCapability },
          },
        },
      ];
      f.request.target.url = 'https://github.com/acme/other.git/info/refs';
      f.resolve.mockImplementationOnce(async ({ grant: current }) => ({
        grant: current,
        credential: memberCapability,
      }));

      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({
        ok: true,
        authority: { type: 'managed', provider: 'github', capability: memberCapability },
      });
    });

    it('denies a launch capability when the request URL names another member', async () => {
      const f = fixture(provider);
      f.scope.additionalRepositories = [
        {
          repository: {
            type: 'github',
            repo: 'acme/other',
            authentication: 'managed',
            allowUserAuthorization: false,
          },
          scm: {
            ...f.scope.scm!,
            gitUrl: 'https://github.com/acme/other.git',
            capability: { ...f.scope.scm!.capability!, credential: 'kgh2.member' },
          },
        },
      ];
      f.request.target.url = 'https://github.com/acme/other.git/info/refs';
      f.resolve.mockImplementationOnce(async ({ grant: current }) => ({
        grant: current,
        credential: current.scm!.capability!.credential,
      }));

      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({
        ok: false,
        code: 'credential_denied',
      });
      expect(f.persist).not.toHaveBeenCalled();
    });

    it('admits an additional GitLab alias on its own host', async () => {
      const f = fixture(provider);
      const alias = createControlPlaneCredential(logicalId, 'gitlab');
      f.scope.additionalRepositories = [
        {
          repository: { type: 'gitlab', url: 'https://gitlab.com/group/project.git' },
          scm: {
            purpose: 'gitlab',
            alias,
            gitUrl: 'https://gitlab.com/group/project.git',
            capability: {
              credential: 'kgl2.member',
              outboundContainerId: 'allocation-binding',
              issuedAt: time - 1000,
              expiresAt: time + 300_000,
            },
            gitlab: {
              instanceOrigin: 'https://gitlab.com',
              instanceHost: 'gitlab.com',
              projectPath: 'group/project',
              integrationId: 'integration-test',
              authType: 'pat',
              identity: { accountId: '42', accountLogin: 'bot' },
              glabIsOAuth2: false,
            },
          },
        },
      ];
      f.request.target.url = 'https://gitlab.com/group/project.git/info/refs';
      f.request.authorization.authorization = `Bearer ${alias}`;
      f.resolve.mockImplementationOnce(async ({ grant: current }) => ({
        grant: current,
        credential: 'kgl2.member',
      }));

      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({
        ok: true,
        authority: { type: 'managed', provider: 'gitlab', capability: 'kgl2.member' },
      });
    });

    it('rejects expired identity evidence before grant persistence', async () => {
      const f = fixture(provider);
      let identityCurrent = true;
      f.deps.authenticate = async () => ({ ok: true, isCurrent: () => identityCurrent });
      const renew = f.resolve.getMockImplementation()!;
      f.resolve.mockImplementationOnce(async input => {
        identityCurrent = false;
        return renew(input);
      });
      expect(await admitScmRequest(f.request, f.deps)).toMatchObject({ ok: false });
      expect(f.persist).not.toHaveBeenCalled();
    });
  }
);
