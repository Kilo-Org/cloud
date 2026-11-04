import { describe, expect, it } from '@jest/globals';
import type {
  EnvironmentSetupRunStatus,
  EnvironmentSetupVerification,
} from '@kilocode/cloud-agent-profile';
import type { SetupRunDiff } from '@/lib/cloud-agent/environment-setup/diff';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import {
  setupRunActions,
  setupRunBadge,
  setupRunChanges,
  setupRunNetworkLabel,
  setupRunStopNotice,
  setupRunVerificationSummary,
} from './environment-setup-run-display';

function diff(overrides: Partial<SetupRunDiff> = {}): SetupRunDiff {
  return {
    scriptChanged: false,
    scriptBefore: '',
    scriptAfter: '',
    plainVarsAdded: [],
    plainVarsRemoved: [],
    plainVarsChanged: [],
    secretKeysAdded: [],
    secretKeysRemoved: [],
    sandboxAllocation: null,
    egress: null,
    requiredHostsAdded: [],
    requiredHostsRemoved: [],
    repositoriesAdded: [],
    repositoriesRemoved: [],
    ...overrides,
  };
}

function verification(
  overrides: Partial<EnvironmentSetupVerification> = {}
): EnvironmentSetupVerification {
  return {
    childSessionId: 'child',
    childKiloSessionId: null,
    configurationRevision: 3,
    preparation: 'completed',
    preparationError: null,
    setupDurationMs: 280_000,
    egressMode: 'allowlist',
    checks: [],
    results: [],
    testedHeadSha: null,
    recordedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('setupRunBadge', () => {
  it.each([
    ['starting', 'Working'],
    ['running', 'Working'],
    ['needs_input', 'Needs your input'],
    ['verifying', 'Testing'],
    ['waiting_for_merge', 'Waiting for pull request'],
    ['publish_conflict', 'Needs a decision'],
    ['failed', 'Stopped'],
    ['published', 'Published'],
    ['reverted', 'Reverted'],
    ['cancelled', 'Cancelled'],
  ] satisfies [EnvironmentSetupRunStatus, string][])('labels %s as %s', (status, text) => {
    expect(setupRunBadge(status).text).toBe(text);
  });

  it('reserves the destructive badge for stopped and conflicted runs', () => {
    expect(setupRunBadge('failed').variant).toBe('destructive');
    expect(setupRunBadge('publish_conflict').variant).toBe('destructive');
    expect(setupRunBadge('published').variant).toBe('new');
  });
});

describe('setupRunChanges', () => {
  it('lists no changes for an empty diff', () => {
    expect(setupRunChanges(diff())).toEqual([]);
  });

  it('reports the script before and after', () => {
    expect(
      setupRunChanges(diff({ scriptChanged: true, scriptBefore: 'a', scriptAfter: 'b' }))
    ).toEqual([{ kind: 'script', before: 'a', after: 'b' }]);
  });

  it('summarises variable and secret key changes with their kind', () => {
    expect(
      setupRunChanges(
        diff({
          plainVarsAdded: ['ADDED'],
          plainVarsRemoved: ['REMOVED'],
          plainVarsChanged: ['CHANGED'],
          secretKeysAdded: ['SECRET'],
          secretKeysRemoved: ['OLD_SECRET'],
        })
      )
    ).toEqual([
      { kind: 'text', text: 'Variables: +ADDED, −REMOVED, ~CHANGED' },
      { kind: 'text', text: 'Secrets: +SECRET, −OLD_SECRET' },
    ]);
  });

  it('shows the sandbox transition and required host changes', () => {
    expect(
      setupRunChanges(
        diff({
          sandboxAllocation: { before: null, after: 'large' },
          requiredHostsAdded: ['registry.npmjs.org'],
          requiredHostsRemoved: ['old.example.com'],
        })
      )
    ).toEqual([
      { kind: 'text', text: 'Sandbox: default → large' },
      { kind: 'text', text: 'Required hosts: +registry.npmjs.org, −old.example.com' },
    ]);
  });

  it('names the network modes when the mode changes', () => {
    expect(
      setupRunChanges(
        diff({
          egress: {
            before: { mode: 'unrestricted', allowlist: [] },
            after: { mode: 'allowlist', allowlist: ['registry.npmjs.org'] },
          },
        })
      )
    ).toEqual([{ kind: 'text', text: 'Network: full → allowlist' }]);
  });

  it('shows allowlist host changes when the mode stays the same', () => {
    expect(
      setupRunChanges(
        diff({
          egress: {
            before: { mode: 'allowlist', allowlist: ['old.example.com', 'kept.example.com'] },
            after: { mode: 'allowlist', allowlist: ['kept.example.com', 'new.example.com'] },
          },
        })
      )
    ).toEqual([{ kind: 'text', text: 'Network: +new.example.com, −old.example.com' }]);
  });
});

describe('setupRunVerificationSummary', () => {
  it('reports a passing run with its duration', () => {
    expect(setupRunVerificationSummary(verification())).toBe('Setup passed in 4m 40s');
  });

  it('reports a passing run without a duration', () => {
    expect(setupRunVerificationSummary(verification({ setupDurationMs: null }))).toBe(
      'Setup passed'
    );
  });

  it('reports the preparation error before any checks', () => {
    expect(
      setupRunVerificationSummary(
        verification({ preparation: 'failed', preparationError: 'Snapshot not found' })
      )
    ).toBe('Setup failed: Snapshot not found');
  });

  it('does not repeat an individual check failure in the summary', () => {
    expect(
      setupRunVerificationSummary(
        verification({
          results: [
            { name: 'install', passed: true, evidence: '' },
            { name: 'web tests', passed: false, evidence: '2 failing' },
          ],
        })
      )
    ).toBe('Setup passed in 4m 40s');
  });
});

describe('setupRunStopNotice', () => {
  function stoppedRun(
    overrides: Partial<
      Pick<
        SetupRunResponse,
        'status' | 'statusReason' | 'statusDetail' | 'agentState' | 'cloudAgentSessionId'
      >
    >
  ) {
    return {
      status: 'failed' as const,
      statusReason: null,
      statusDetail: null,
      agentState: null,
      cloudAgentSessionId: 'workspace_1',
      ...overrides,
    };
  }

  it('shows the status detail for a failed run', () => {
    expect(
      setupRunStopNotice(
        stoppedRun({
          statusReason: 'agent_failed',
          statusDetail: 'The dependency needs a full VM.',
        })
      )
    ).toBe('The dependency needs a full VM.');
  });

  it('maps a known failure reason', () => {
    expect(
      setupRunStopNotice(stoppedRun({ statusReason: 'verification_limit_reached' }))
    ).toBe('The setup reached its test limit.');
  });

  it('never shows an unknown failure code', () => {
    expect(setupRunStopNotice(stoppedRun({ statusReason: 'something_new' }))).toBe(
      'The setup stopped.'
    );
  });

  it('maps a stopped agent reason while the run is still running', () => {
    expect(
      setupRunStopNotice(
        stoppedRun({
          status: 'running',
          agentState: { kind: 'stopped', reason: 'no_progress' },
        })
      )
    ).toBe('The agent stopped: it made no progress.');
  });

  it('never shows a raw agent stop reason', () => {
    expect(
      setupRunStopNotice(
        stoppedRun({
          status: 'running',
          agentState: { kind: 'stopped', reason: 'setup session stopped' },
        })
      )
    ).toBe('The setup stopped.');
  });

  it('shows nothing for a run that is not stopped', () => {
    expect(
      setupRunStopNotice(stoppedRun({ status: 'running', agentState: { kind: 'working' } }))
    ).toBeNull();
  });
});

describe('setupRunActions', () => {
  const published = { status: 'published', canRevert: true, targetEnvironmentId: 'target' } as const;
  const manage = { canManage: true, hasStoppedSection: false };

  it('offers revert and a snapshot for a published run', () => {
    expect(setupRunActions(published, manage)).toEqual(['revert', 'buildSnapshot']);
  });

  it('omits revert when the run cannot be reverted', () => {
    expect(setupRunActions({ ...published, canRevert: false }, manage)).toEqual(['buildSnapshot']);
  });

  it('offers publish and discard for a publish conflict', () => {
    expect(setupRunActions({ ...published, status: 'publish_conflict' }, manage)).toEqual([
      'publishAnyway',
      'discard',
    ]);
  });

  it('offers publish and cancel while waiting for a merge', () => {
    expect(setupRunActions({ ...published, status: 'waiting_for_merge' }, manage)).toEqual([
      'publishNow',
      'cancel',
    ]);
  });

  it('offers only cancel for other open statuses', () => {
    expect(setupRunActions({ ...published, status: 'running' }, manage)).toEqual(['cancel']);
    expect(setupRunActions({ ...published, status: 'failed' }, manage)).toEqual(['cancel']);
  });

  it('hides the generic cancel when the stopped section is shown', () => {
    expect(
      setupRunActions(
        { ...published, status: 'running' },
        { canManage: true, hasStoppedSection: true }
      )
    ).toEqual([]);
  });

  it('shows no actions to members without the manage role', () => {
    expect(
      setupRunActions(published, { canManage: false, hasStoppedSection: false })
    ).toEqual([]);
  });
});

describe('setupRunNetworkLabel', () => {
  it('maps the egress modes to the copy the card uses', () => {
    expect(setupRunNetworkLabel('allowlist')).toBe('allowlist');
    expect(setupRunNetworkLabel('unrestricted')).toBe('full');
    expect(setupRunNetworkLabel(null)).toBeNull();
  });
});
