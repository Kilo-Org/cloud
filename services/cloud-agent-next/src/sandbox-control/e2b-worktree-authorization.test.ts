/**
 * Unit tests for the retargeted `authorizeE2BSessionRequest`. The authorizer is
 * fail-closed: it admits only an `allocated` canonical record whose submitted
 * E2B block carries a reference, whose resolved containment is the reference-
 * bound worktree containment, and for which a matching live grant exists. It
 * does not own the hard-stop cap; that lives in the request admission predicate.
 */
import { describe, expect, it } from 'vitest';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import type { E2BSandboxProviderBinding } from '../sandbox-provider-binding.js';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import type { SessionCredentialGrant } from './session-credentials.js';
import type { SessionRoute } from './session-routes.js';
import { authorizeE2BSessionRequest } from './e2b-worktree-authorization.js';

const NOW = 1_000_000;
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const CREDENTIAL = 'bbbbbbbb-2222-4222-8222-222222222222';
const OWNER = 'oauth/e2b-authorization';
const SESSION = 'workspace_authorization';
const KILO_SESSION = 'ses_abcdefghijklmnopqrstuvwxyz';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const DIRECTORY = '/workspace/authorization';
const REF = 'e2b1:physicalsandbox:intent-1';
const SCOPE = 'scope-authorization';
const TOKEN = 'fixture-kilo-token';
const TARGETS = {
  backendBaseUrl: 'https://backend.example.test',
  providerBaseUrl: 'https://provider.example.test',
  sessionIngestBaseUrl: 'https://ingest.example.test',
};

const BINDING: E2BSandboxProviderBinding = {
  kind: 'e2b',
  organizationId: ORG,
  credentialId: CREDENTIAL,
};

const ROUTE: SessionRoute = {
  sessionId: SESSION,
  kiloSessionId: KILO_SESSION,
  directory: DIRECTORY,
  ownerId: OWNER,
  lastState: null,
  lastStateAt: null,
  idleForMs: null,
  waitingOn: null,
};

const TARGET: AllocationTarget = {
  provider: 'e2b',
  providerRef: REF,
  capabilities: { persistentWorkspace: false, destroysOnStop: true },
  e2b: {
    binding: BINDING,
    sandboxId: SANDBOX_ID,
    templateId: 'kilotemplate123',
    templateReference: 'kilocode/cloud-agent:cccccccc-4444-4444-8444-444444444444',
    runtimeBuildId: 'kilo-runtime-test-build',
    resourceProfile: { cpuCount: 2, memoryMB: 4096 },
    hardStopAt: NOW + 3_000_000,
    submissionState: 'submitted',
    submittedAt: NOW - 1_000,
    createDeadlineAt: NOW + 60_000,
    reconciliationDeadlineAt: NOW + 60_000,
    reconciliationAlarmAt: NOW + 40_000,
  },
  resolvedContainment: {
    kilocode: false,
    github: false,
    worktreeScoped: true,
    providerRef: REF,
  },
};

function allocated(overrides: Partial<AllocationTarget> = {}): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: { ...TARGET, ...overrides },
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
      health: {
        kind: 'healthy',
        incarnation: REF,
        lastHeartbeat: { incarnation: REF, at: NOW, ready: true },
        deadlineAt: NOW + 90_000,
      },
      idleAt: null,
    },
  };
}

function grant(overrides: Partial<SessionCredentialGrant> = {}): SessionCredentialGrant {
  return {
    version: 1,
    containmentEnabled: false,
    scopeId: SCOPE,
    sandboxId: SANDBOX_ID,
    directory: DIRECTORY,
    userId: OWNER,
    orgId: ORG,
    provider: 'e2b',
    providerBinding: BINDING,
    members: [{ sessionId: SESSION, kiloSessionId: KILO_SESSION }],
    kilo: { token: TOKEN, targets: TARGETS, capabilities: {} },
    preparedAt: NOW - 1_000,
    expiresAt: NOW + 1_000,
    ...overrides,
  } as SessionCredentialGrant;
}

function attachPayload(kilo: Record<string, unknown>) {
  return { kilo: { scopeId: SCOPE, token: TOKEN, targets: TARGETS, ...kilo } };
}

function thrownPolicyError(run: () => void): E2BProviderError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof E2BProviderError ? error : undefined;
  }
}

function authorize(input: {
  binding?: Parameters<typeof authorizeE2BSessionRequest>[0]['binding'];
  allocation?: AllocationRecord;
  grants?: SessionCredentialGrant[];
  route?: SessionRoute;
  attachPayload?: unknown;
  now?: number;
}): E2BProviderError | undefined {
  return thrownPolicyError(() =>
    authorizeE2BSessionRequest({
      binding: input.binding ?? BINDING,
      allocation: input.allocation ?? allocated(),
      route: input.route ?? ROUTE,
      grants: input.grants ?? [grant()],
      now: input.now ?? NOW,
      ...(input.attachPayload === undefined ? {} : { attachPayload: input.attachPayload }),
    })
  );
}

describe('authorizeE2BSessionRequest', () => {
  it('accepts a matching allocated record and live grant', () => {
    expect(authorize({})).toBeUndefined();
  });

  it('accepts an attach payload that matches the grant exactly', () => {
    expect(
      authorize({
        attachPayload: attachPayload({
          containmentEnabled: false,
          organizationId: ORG,
        }),
      })
    ).toBeUndefined();
  });

  it('ignores a non-E2B binding', () => {
    expect(
      authorize({
        binding: { kind: 'cloudflare' },
        allocation: {
          v: 2,
          resumable: true,
          state: { kind: 'stopped', summary: null },
        },
      })
    ).toBeUndefined();
  });

  it.each(['creating', 'stopping', 'unknown', 'stopped'] as const)(
    'rejects a %s record',
    kind => {
      const allocation =
        kind === 'stopped'
          ? ({ v: 2, resumable: true, state: { kind: 'stopped', summary: null } } as AllocationRecord)
          : ({
              ...allocated(),
              state: {
                kind,
                target: TARGET,
                createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
              },
            } as unknown as AllocationRecord);
      expect(authorize({ allocation })?.code).toBe('byoc_e2b_policy_mismatch');
    }
  );

  it('rejects an allocated record whose reference is null', () => {
    expect(authorize({ allocation: allocated({ providerRef: null }) })?.code).toBe(
      'byoc_e2b_policy_mismatch'
    );
  });

  it('rejects a containment that is not the worktree containment bound to the reference', () => {
    for (const resolvedContainment of [
      { kilocode: true, github: false, worktreeScoped: true as const, providerRef: REF },
      { kilocode: false, github: true, worktreeScoped: true as const, providerRef: REF },
      { kilocode: false, github: false, worktreeScoped: true as const, providerRef: 'other' },
    ]) {
      expect(
        authorize({ allocation: allocated({ resolvedContainment }) })?.code
      ).toBe('byoc_e2b_policy_mismatch');
    }
  });

  it.each([
    ['no grant', []],
    ['wrong provider binding', [grant({ providerBinding: { ...BINDING, credentialId: ORG } })]],
    ['wrong organization', [grant({ orgId: CREDENTIAL })]],
    ['wrong sandbox id', [grant({ sandboxId: 'ses-22222222222242228222222222222222' })]],
    ['wrong owner', [grant({ userId: 'oauth/other' })]],
    ['wrong directory', [grant({ directory: '/workspace/other' })]],
    [
      'no matching member',
      [grant({ members: [{ sessionId: 'other', kiloSessionId: KILO_SESSION }] })],
    ],
  ])('rejects with %s', (_name, grants) => {
    expect(authorize({ grants })?.code).toBe('byoc_e2b_policy_mismatch');
  });

  it('rejects a grant that is not yet prepared or already expired', () => {
    expect(
      authorize({ grants: [grant({ preparedAt: NOW + 1, expiresAt: NOW + 5_000 })] })?.code
    ).toBe('byoc_e2b_policy_mismatch');
    expect(authorize({ grants: [grant({ expiresAt: NOW })] })?.code).toBe(
      'byoc_e2b_policy_mismatch'
    );
  });

  it('rejects an attach payload whose containment policy disagrees with the direct grant', () => {
    expect(
      authorize({
        attachPayload: attachPayload({
          containmentEnabled: true,
          organizationId: ORG,
        }),
      })?.code
    ).toBe('byoc_e2b_policy_mismatch');
  });

  it('rejects an attach payload whose token or targets disagree with the grant', () => {
    expect(
      authorize({
        attachPayload: attachPayload({
          containmentEnabled: false,
          organizationId: ORG,
          token: 'other-token',
        }),
      })?.code
    ).toBe('byoc_e2b_policy_mismatch');
    expect(
      authorize({
        attachPayload: {
          kilo: {
            scopeId: SCOPE,
            token: TOKEN,
            containmentEnabled: false,
            organizationId: ORG,
            targets: { ...TARGETS, providerBaseUrl: 'https://other.example.test' },
          },
        },
      })?.code
    ).toBe('byoc_e2b_policy_mismatch');
  });
});
