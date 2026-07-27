import {
  CLOUD_AGENT_FAILURE_CODES,
  WORKSPACE_FAILURE_SUBTYPES,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { CLOUD_AGENT_TERMINAL_REASONS } from '@kilocode/worker-utils/cloud-agent-next-client';
import { CODE_REVIEW_TERMINAL_REASONS } from '@kilocode/db/schema-types';
import { terminalReasonFromCloudAgentFailure } from './terminal-reason-from-failure';

describe('terminal reason list parity', () => {
  // These two lists live in separate packages that cannot import each other, so
  // drift is only caught here. A mismatch makes the orchestrator send a reason
  // the callback allowlist rejects, or makes the worker's zod enum silently
  // coerce a valid reason to undefined via its `.catch(undefined)`.
  it('keeps the db and worker-utils terminal reason lists identical', () => {
    expect([...CLOUD_AGENT_TERMINAL_REASONS].sort()).toEqual(
      [...CODE_REVIEW_TERMINAL_REASONS].sort()
    );
  });
});

describe('terminalReasonFromCloudAgentFailure', () => {
  it('returns undefined without a structured failure', () => {
    expect(terminalReasonFromCloudAgentFailure(undefined)).toBeUndefined();
    expect(terminalReasonFromCloudAgentFailure({})).toBeUndefined();
  });

  it('prefers the workspace subtype over the generic code', () => {
    expect(
      terminalReasonFromCloudAgentFailure({
        code: 'workspace_setup_failed',
        subtype: 'sandbox_storage_full',
      })
    ).toBe('workspace_capacity');

    expect(
      terminalReasonFromCloudAgentFailure({
        code: 'workspace_setup_failed',
        subtype: 'git_authentication_failed',
      })
    ).toBe('repository_auth_failed');
  });

  it('falls back to the generic workspace reason without a subtype', () => {
    expect(terminalReasonFromCloudAgentFailure({ code: 'workspace_setup_failed' })).toBe(
      'workspace_setup_failed'
    );
  });

  it('maps the codes behind the largest uncategorized buckets', () => {
    expect(terminalReasonFromCloudAgentFailure({ code: 'assistant_error' })).toBe(
      'assistant_failed'
    );
    expect(terminalReasonFromCloudAgentFailure({ code: 'wrapper_error_after_activity' })).toBe(
      'wrapper_failed'
    );
  });

  it('splits assistant failures by their safe message', () => {
    expect(
      terminalReasonFromCloudAgentFailure({
        code: 'assistant_error',
        message: 'Assistant request was rate limited',
      })
    ).toBe('assistant_rate_limited');

    expect(
      terminalReasonFromCloudAgentFailure({
        code: 'assistant_error',
        message: 'Assistant service is unavailable',
      })
    ).toBe('assistant_unavailable');
  });

  it('reads the assistant message from the callback errorMessage when absent on the failure', () => {
    expect(
      terminalReasonFromCloudAgentFailure(
        { code: 'assistant_error' },
        'Assistant request was rate limited'
      )
    ).toBe('assistant_rate_limited');
  });

  it('degrades to the generic assistant reason on an unrecognized message', () => {
    expect(
      terminalReasonFromCloudAgentFailure({
        code: 'assistant_error',
        message: 'Assistant request failed in some new way',
      })
    ).toBe('assistant_failed');
  });

  it('leaves unclassified failures to the callers message-based inference', () => {
    expect(terminalReasonFromCloudAgentFailure({ code: 'unclassified' })).toBeUndefined();
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
    'does not resolve inherited object members for message %p',
    message => {
      // A plain object lookup would return a truthy Object.prototype member and
      // write a function reference into the terminal_reason column.
      expect(terminalReasonFromCloudAgentFailure({ code: 'assistant_error', message })).toBe(
        'assistant_failed'
      );
    }
  );

  it('resolves every failure code to a valid terminal reason', () => {
    const valid = new Set<string>(CODE_REVIEW_TERMINAL_REASONS);
    const resolved = CLOUD_AGENT_FAILURE_CODES.map(code => [
      code,
      terminalReasonFromCloudAgentFailure({ code }),
    ]);

    // Reported as a table so a future code addition names itself in the failure.
    expect(
      resolved.filter(([code, reason]) =>
        code === 'unclassified' ? reason !== undefined : !valid.has(reason as string)
      )
    ).toEqual([]);
  });

  it('resolves every workspace subtype to a valid terminal reason', () => {
    const valid = new Set<string>(CODE_REVIEW_TERMINAL_REASONS);
    const resolved = WORKSPACE_FAILURE_SUBTYPES.map(subtype => [
      subtype,
      terminalReasonFromCloudAgentFailure({ code: 'workspace_setup_failed', subtype }),
    ]);

    expect(resolved.filter(([, reason]) => !valid.has(reason as string))).toEqual([]);
  });
});
