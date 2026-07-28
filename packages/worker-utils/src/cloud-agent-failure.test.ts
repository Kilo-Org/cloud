import { describe, expect, it } from 'vitest';
import {
  CLOUD_AGENT_FAILURE_CODES,
  CLOUD_AGENT_FAILURE_STAGES,
  CloudAgentCallbackFailureSchema,
  CloudAgentSafeFailureSchema,
  classifyCloudAgentFailure,
  isWorkspaceFailureSubtype,
  WORKSPACE_FAILURE_SUBTYPES,
} from './cloud-agent-failure.js';

describe('CloudAgentCallbackFailureSchema', () => {
  it('retains failures accepted by the strict producer contract', () => {
    const failure = {
      stage: 'pre_dispatch',
      code: 'workspace_setup_failed',
      subtype: 'git_clone_timeout',
      attempts: 2,
      message: 'Repository clone timed out',
    };

    expect(CloudAgentCallbackFailureSchema.parse(failure)).toEqual(failure);
  });

  it.each([
    { code: 'future_failure_code', message: 'Future failure' },
    { code: 'workspace_setup_failed', subtype: 'future_workspace_failure' },
    { code: 'assistant_error', futureField: true },
    { attempts: -1 },
    { message: 'x'.repeat(4_097) },
  ])('discards unsupported or malformed structured failures: %o', failure => {
    expect(CloudAgentCallbackFailureSchema.parse(failure)).toBeUndefined();
  });
});

describe('classifyCloudAgentFailure', () => {
  it.each([
    ['payment_required', 'insufficient_credits'],
    ['model_missing', 'model_unavailable'],
  ] as const)('classifies explicit %s as user action', (code, reason) => {
    expect(classifyCloudAgentFailure({ source: 'run', stage: 'agent_activity', code })).toEqual({
      responsibility: 'user',
      reason,
    });
  });

  it('preserves ambiguous assistant and source-control failures as unknown', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'assistant_error',
        assistantReason: 'unknown',
        providerOwnership: 'unknown',
      })
    ).toEqual({ responsibility: 'unknown', reason: 'assistant_unknown' });
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
        workspaceSubtype: 'git_network_failed',
      })
    ).toEqual({ responsibility: 'unknown', reason: 'source_control_network' });
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
        workspaceSubtype: 'git_pack_corrupt',
      })
    ).toEqual({ responsibility: 'unknown', reason: 'source_control_network' });
  });

  it('uses provider ownership for authentication and availability failures', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'assistant_error',
        assistantReason: 'provider_authentication',
        providerOwnership: 'byok',
      })
    ).toEqual({ responsibility: 'user', reason: 'provider_authentication' });
    expect(
      classifyCloudAgentFailure({
        source: 'run',
        stage: 'agent_activity',
        code: 'assistant_error',
        assistantReason: 'provider_unavailable',
        providerOwnership: 'managed',
      })
    ).toEqual({ responsibility: 'platform', reason: 'managed_provider_unavailable' });
  });

  it('classifies setup failures from structured stage and code only', () => {
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'initial_admission',
        code: 'invalid_initial_intent',
      })
    ).toEqual({ responsibility: 'user', reason: 'initial_request_invalid' });
    expect(
      classifyCloudAgentFailure({
        source: 'setup',
        stage: 'transport',
        code: 'do_rpc_outcome_unknown',
      })
    ).toEqual({ responsibility: 'platform', reason: 'session_coordination' });
  });
});

describe('CloudAgentSafeFailureSchema', () => {
  it('accepts every shared contract value', () => {
    for (const stage of CLOUD_AGENT_FAILURE_STAGES) {
      expect(CloudAgentSafeFailureSchema.safeParse({ stage }).success).toBe(true);
    }
    for (const code of CLOUD_AGENT_FAILURE_CODES) {
      expect(CloudAgentSafeFailureSchema.safeParse({ code }).success).toBe(true);
    }
    for (const subtype of WORKSPACE_FAILURE_SUBTYPES) {
      expect(
        CloudAgentSafeFailureSchema.safeParse({ code: 'workspace_setup_failed', subtype }).success
      ).toBe(true);
      expect(isWorkspaceFailureSubtype(subtype)).toBe(true);
    }
  });

  it('requires workspace_setup_failed when subtype is present', () => {
    expect(CloudAgentSafeFailureSchema.safeParse({ subtype: 'git_clone_timeout' }).success).toBe(
      false
    );
    expect(
      CloudAgentSafeFailureSchema.safeParse({
        code: 'assistant_error',
        subtype: 'git_clone_timeout',
      }).success
    ).toBe(false);
  });

  it('enforces strict optional field bounds', () => {
    expect(CloudAgentSafeFailureSchema.safeParse({}).success).toBe(true);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: 0, message: 'x' }).success).toBe(true);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: -1 }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ attempts: 1.5 }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ message: '' }).success).toBe(false);
    expect(CloudAgentSafeFailureSchema.safeParse({ message: 'x'.repeat(4_097) }).success).toBe(
      false
    );
    expect(CloudAgentSafeFailureSchema.safeParse({ extra: true }).success).toBe(false);
    expect(isWorkspaceFailureSubtype('not_allowlisted')).toBe(false);
  });
});
