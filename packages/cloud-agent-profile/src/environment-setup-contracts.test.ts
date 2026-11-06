import { describe, expect, it } from 'vitest';
import {
  effectiveEgressAllowlist,
  evaluateCompletionGate,
  isAgentWritableSetupRunStatus,
  isHighPrivilegeSecretKey,
  isOpenSetupRunStatus,
  isRestrictedEgress,
  mergeRequiredHosts,
  pendingRequestCount,
  type EnvironmentSetupCompletionGateInput,
  type EnvironmentSetupVerification,
} from './environment-setup-contracts';

function verification(
  overrides: Partial<EnvironmentSetupVerification> = {}
): EnvironmentSetupVerification {
  return {
    childSessionId: 'child-session',
    childKiloSessionId: null,
    configurationRevision: 3,
    preparation: 'completed',
    preparationError: null,
    setupDurationMs: 1000,
    egressMode: 'unrestricted',
    sandboxAllocation: 'standard-2',
    egressAllowlist: null,
    checks: [{ name: 'tests', command: 'pnpm test', expect: 'exit 0' }],
    results: [{ name: 'tests', passed: true, evidence: '42 passed' }],
    recordedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

function gateInput(
  overrides: Partial<EnvironmentSetupCompletionGateInput> = {}
): EnvironmentSetupCompletionGateInput {
  return {
    draftRevision: 3,
    draftSandboxAllocation: 'standard-2',
    draftEgressMode: null,
    draftEgressAllowlist: null,
    draftEgressRequiredHosts: null,
    run: {
      last_verification: verification(),
      secret_requests: [],
      network_requests: [],
    },
    ...overrides,
  };
}

describe('environment setup run statuses', () => {
  it('classifies open statuses, including failed', () => {
    expect(isOpenSetupRunStatus('starting')).toBe(true);
    expect(isOpenSetupRunStatus('failed')).toBe(true);
    expect(isOpenSetupRunStatus('published')).toBe(false);
    expect(isOpenSetupRunStatus('reverted')).toBe(false);
    expect(isOpenSetupRunStatus('cancelled')).toBe(false);
  });

  it('classifies the statuses the agent may write in', () => {
    expect(isAgentWritableSetupRunStatus('running')).toBe(true);
    expect(isAgentWritableSetupRunStatus('verifying')).toBe(true);
    expect(isAgentWritableSetupRunStatus('failed')).toBe(false);
    expect(isAgentWritableSetupRunStatus('starting')).toBe(false);
  });
});

describe('pendingRequestCount', () => {
  it('counts pending secret and network requests only', () => {
    expect(
      pendingRequestCount({
        secret_requests: [
          {
            key: 'API_KEY',
            reason: 'tests',
            references: [],
            highPrivilege: false,
            state: 'pending',
            requestedAt: '2026-11-04T00:00:00.000Z',
          },
          {
            key: 'OTHER_KEY',
            reason: 'tests',
            references: [],
            highPrivilege: false,
            state: 'provided',
            requestedAt: '2026-11-04T00:00:00.000Z',
          },
        ],
        network_requests: [
          {
            host: 'api.example.com',
            reason: 'tests',
            evidence: { childSessionId: 'child', deniedCount: 2 },
            state: 'pending',
            requestedAt: '2026-11-04T00:00:00.000Z',
          },
          {
            host: 'cdn.example.com',
            reason: 'tests',
            evidence: { childSessionId: 'child', deniedCount: 1 },
            state: 'declined',
            requestedAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      })
    ).toBe(2);
  });
});

describe('isRestrictedEgress', () => {
  it('is true only for allowlist mode', () => {
    expect(isRestrictedEgress('allowlist')).toBe(true);
    expect(isRestrictedEgress('unrestricted')).toBe(false);
    expect(isRestrictedEgress(null)).toBe(false);
    expect(isRestrictedEgress(undefined)).toBe(false);
  });
});

describe('mergeRequiredHosts', () => {
  it('keeps an absent allowlist absent', () => {
    expect(mergeRequiredHosts(undefined, ['api.example.com'])).toBeUndefined();
  });

  it('appends required hosts after the allowlist, lowercased and de-duplicated', () => {
    expect(
      mergeRequiredHosts(['API.example.com', 'cdn.example.com'], ['api.EXAMPLE.com', 'db.internal'])
    ).toEqual(['api.example.com', 'cdn.example.com', 'db.internal']);
  });

  it('treats a missing required list as empty', () => {
    expect(mergeRequiredHosts(['api.example.com'], null)).toEqual(['api.example.com']);
    expect(mergeRequiredHosts([], undefined)).toEqual([]);
  });
});

describe('effectiveEgressAllowlist', () => {
  it('is null for an unrestricted or absent policy', () => {
    expect(effectiveEgressAllowlist(null, ['api.example.com'], ['cdn.example.com'])).toBeNull();
    expect(
      effectiveEgressAllowlist('unrestricted', ['api.example.com'], ['cdn.example.com'])
    ).toBeNull();
  });

  it('merges allowed and required hosts for a restricted policy', () => {
    expect(
      effectiveEgressAllowlist(
        'allowlist',
        ['API.example.com'],
        ['api.example.com', 'cdn.example.com']
      )
    ).toEqual(['api.example.com', 'cdn.example.com']);
    expect(effectiveEgressAllowlist('allowlist', null, null)).toEqual([]);
  });
});

describe('isHighPrivilegeSecretKey', () => {
  it('matches exact credential names and broad name fragments', () => {
    expect(isHighPrivilegeSecretKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isHighPrivilegeSecretKey('PROD_DATABASE_URL')).toBe(true);
    expect(isHighPrivilegeSecretKey('NPM_TOKEN')).toBe(false);
  });
});

describe('evaluateCompletionGate', () => {
  it('rejects a run without a verification', () => {
    const result = evaluateCompletionGate(
      gateInput({ run: { ...gateInput().run, last_verification: null } })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'No verification has run. Call verify_environment_draft.',
    });
  });

  it('rejects a verification of an older revision', () => {
    const result = evaluateCompletionGate(gateInput({ draftRevision: 4 }));
    expect(result).toEqual({
      ok: false,
      reason: 'The last verification ran revision 3, but the draft is at revision 4. Verify again.',
    });
  });

  it('rejects a failed preparation with its error', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            preparation: 'failed',
            preparationError: 'clone failed',
          }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Setup failed in the last verification: clone failed.',
    });
  });

  it('does not render a null preparation error as text', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            preparation: 'failed',
            preparationError: null,
          }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Setup failed in the last verification: no error reported.',
    });
  });

  it('rejects a verification that recorded no checks', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({ checks: [], results: [] }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'The verification ran no checks. Verify again.',
    });
  });

  it('rejects checks with duplicate names and different commands', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            checks: [
              { name: 'tests', command: 'pnpm test', expect: 'exit 0' },
              { name: 'tests', command: 'pnpm integration', expect: 'exit 0' },
            ],
          }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Verification check names must be unique. Verify again.',
    });
  });

  it('rejects duplicate results even when the first result passed', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            results: [
              { name: 'tests', passed: true, evidence: 'ok' },
              { name: 'tests', passed: false, evidence: 'failed command' },
            ],
          }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Verification result names must be unique. Record the results again.',
    });
  });

  it('rejects a sandbox allocation change after verification', () => {
    const result = evaluateCompletionGate(gateInput({ draftSandboxAllocation: 'standard-4' }));
    expect(result).toEqual({
      ok: false,
      reason: 'The sandbox allocation changed after verification. Verify again.',
    });
  });

  it('rejects an allowed host change after verification', () => {
    const result = evaluateCompletionGate(
      gateInput({
        draftEgressMode: 'allowlist',
        draftEgressAllowlist: ['api.example.com'],
        draftEgressRequiredHosts: null,
        run: {
          ...gateInput().run,
          last_verification: verification({ egressMode: 'allowlist', egressAllowlist: [] }),
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'The allowed network hosts changed after verification. Verify again.',
    });
  });

  it('accepts a verification whose effective allowlist matches the draft', () => {
    expect(
      evaluateCompletionGate(
        gateInput({
          draftEgressMode: 'allowlist',
          draftEgressAllowlist: ['api.example.com'],
          draftEgressRequiredHosts: ['cdn.example.com'],
          run: {
            ...gateInput().run,
            last_verification: verification({
              egressMode: 'allowlist',
              egressAllowlist: ['api.example.com', 'cdn.example.com'],
            }),
          },
        })
      )
    ).toEqual({ ok: true });
  });

  it('rejects a planned check without a passing result', () => {
    const missing = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            checks: [
              { name: 'tests', command: 'pnpm test', expect: 'exit 0' },
              { name: 'lint', command: 'pnpm lint', expect: 'exit 0' },
            ],
          }),
        },
      })
    );
    expect(missing).toEqual({ ok: false, reason: 'Check "lint" did not pass.' });

    const failed = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          last_verification: verification({
            results: [{ name: 'tests', passed: false, evidence: '1 failed' }],
          }),
        },
      })
    );
    expect(failed).toEqual({ ok: false, reason: 'Check "tests" did not pass.' });
  });

  it('rejects pending user requests', () => {
    const result = evaluateCompletionGate(
      gateInput({
        run: {
          ...gateInput().run,
          secret_requests: [
            {
              key: 'API_KEY',
              reason: 'tests',
              references: [],
              highPrivilege: false,
              state: 'pending',
              requestedAt: '2026-11-04T00:00:00.000Z',
            },
          ],
        },
      })
    );
    expect(result).toEqual({ ok: false, reason: '1 requests are still pending for the user.' });
  });

  it('rejects a verification that ran with a different network mode', () => {
    const result = evaluateCompletionGate(gateInput({ draftEgressMode: 'allowlist' }));
    expect(result).toEqual({
      ok: false,
      reason:
        'The verification ran with a different network mode than sessions will use. Verify again.',
    });
  });

  it('accepts a verification that ran with the session network mode', () => {
    expect(
      evaluateCompletionGate(
        gateInput({
          draftEgressMode: 'allowlist',
          run: {
            ...gateInput().run,
            last_verification: verification({ egressMode: 'allowlist' }),
          },
        })
      )
    ).toEqual({ ok: true });

    expect(evaluateCompletionGate(gateInput({ draftEgressMode: 'unrestricted' }))).toEqual({
      ok: true,
    });
  });
});
