import { describe, expect, it } from 'vitest';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import { grant, logicalId, time } from './test-fixtures.js';
import {
  configuredVercelForwardUrl,
  hasManagedScmCapability,
  managedScmForwardingTargets,
} from './targets.js';

describe('managed SCM forwarding targets', () => {
  it('projects all supported hosts from active structural grants', () => {
    expect(
      managedScmForwardingTargets([grant(), grant('gitlab'), grant('bitbucket')], time)
    ).toEqual([
      'api.bitbucket.org',
      'api.github.com',
      'bitbucket.org',
      'github.com',
      'gitlab.example:8443',
      'npm.pkg.github.com',
      'uploads.github.com',
    ]);
  });
  it('excludes legacy, explicit, direct, expired and memberless grants', () => {
    const legacy = grant();
    delete legacy.scm!.capability;
    legacy.scm!.nativeToken = 'legacy';
    const explicit = grant();
    explicit.repository = {
      type: 'github',
      repo: 'acme/repo',
      authentication: 'explicit',
      allowUserAuthorization: false,
    };
    const direct = { ...grant(), containmentEnabled: false };
    const expired = { ...grant(), expiresAt: time };
    const memberless = { ...grant(), members: [] };
    expect(hasManagedScmCapability(legacy)).toBe(false);
    expect(hasManagedScmCapability(explicit)).toBe(false);
    expect(hasManagedScmCapability(direct)).toBe(false);
    expect(
      managedScmForwardingTargets([legacy, explicit, direct, expired, memberless], time)
    ).toEqual([]);
  });
  it('projects the host of an additional GitLab repository', () => {
    const scope = grant();
    const outboundContainerId = scope.outboundContainerId;
    if (!outboundContainerId) throw new Error('fixture grant has no outbound container');
    scope.additionalRepositories = [
      {
        repository: { type: 'gitlab', url: 'https://gitlab.com/group/project.git' },
        scm: {
          purpose: 'gitlab',
          alias: createControlPlaneCredential(logicalId, 'gitlab'),
          gitUrl: 'https://gitlab.com/group/project.git',
          capability: {
            credential: 'kgl2.member',
            outboundContainerId,
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
    expect(managedScmForwardingTargets([scope], time)).toEqual([
      'api.github.com',
      'github.com',
      'gitlab.com',
      'npm.pkg.github.com',
      'uploads.github.com',
    ]);
  });
  it('does not project unvalidated GitLab instances or inconsistent bindings', () => {
    const mismatched = grant('gitlab');
    mismatched.scm!.gitlab!.instanceHost = 'attacker.test';
    const userinfo = grant('gitlab');
    userinfo.scm!.gitlab!.instanceOrigin = 'https://user@gitlab.example:8443/gitlab';
    const http = grant('gitlab');
    http.scm!.gitlab!.instanceOrigin = 'http://gitlab.example:8443/gitlab';
    const binding = grant();
    binding.scm!.capability!.outboundContainerId = 'foreign-allocation';
    expect(managedScmForwardingTargets([mismatched, userinfo, http, binding], time)).toEqual([]);
  });
  it('owns the exact audience independently of request headers and aliases', () => {
    expect(
      configuredVercelForwardUrl({ WORKER_URL: 'https://worker.test/ignored-base/' }, 'sbx_logical')
    ).toBe('https://worker.test/scm/vercel/sbx_logical');
    for (const WORKER_URL of [
      'http://worker.test',
      'https://user@worker.test',
      'https://worker.test?query=x',
      'https://worker.test/#fragment',
    ])
      expect(configuredVercelForwardUrl({ WORKER_URL }, 'sbx_logical')).toBeNull();
    expect(
      configuredVercelForwardUrl({ WORKER_URL: 'https://worker.test' }, '../foreign')
    ).toBeNull();
  });
});
