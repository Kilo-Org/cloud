import {
  buildSetupRunDiff,
  type SetupRunConfigView,
} from '@/lib/cloud-agent/environment-setup/diff';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import {
  environmentSetupStatusLabels,
  canContinueEnvironmentSetup,
  formatEnvironmentSetupDiff,
  formatSetupDuration,
  setupTestChatId,
} from './environment-setup-display';

const baseline: SetupRunConfigView = {
  script: 'pnpm install',
  plainVars: { KEEP: 'same', REMOVE: 'old', CHANGE: 'private-before' },
  secretKeys: ['OLD_SECRET'],
  sandboxAllocation: null,
  egressMode: 'allowlist',
  egressAllowlist: [],
  requiredHosts: ['old.example.com'],
  repositories: ['org/repo'],
};

describe('environment setup display', () => {
  it('names every status, including the starting state', () => {
    expect(environmentSetupStatusLabels).toEqual({
      starting: 'Starting',
      running: 'Working',
      needs_input: 'Needs your input',
      verifying: 'Testing',
      publish_conflict: 'Needs a decision',
      failed: 'Stopped',
      published: 'Published',
      reverted: 'Reverted',
      cancelled: 'Cancelled',
    });
  });

  it.each([
    ['running', 'idle', true],
    ['running', 'stopped', true],
    ['running', 'working', false],
    ['running', 'unknown', false],
    ['failed', 'unknown', true],
    ['verifying', 'idle', false],
    ['verifying', 'stopped', false],
    ['starting', 'idle', false],
    ['needs_input', 'idle', false],
    ['publish_conflict', 'idle', false],
    ['published', 'idle', false],
    ['cancelled', 'idle', false],
    ['reverted', 'idle', false],
  ] as const)('offers Continue for %s / %s: %s', (status, kind, expected) => {
    const run = {
      status,
      agentState: { kind },
      draftEnvironmentId: 'draft-id',
    } as SetupRunResponse;
    expect(canContinueEnvironmentSetup(run)).toBe(expected);
    expect(canContinueEnvironmentSetup({ ...run, draftEnvironmentId: null })).toBe(false);
  });

  it('formats configuration changes without displaying variable values', () => {
    const diff = buildSetupRunDiff(baseline, {
      ...baseline,
      script: 'pnpm install --frozen-lockfile',
      plainVars: { KEEP: 'same', ADD: 'private-added', CHANGE: 'private-after' },
      secretKeys: ['NEW_SECRET'],
      sandboxAllocation: 'larger',
      egressAllowlist: ['registry.example.com'],
      requiredHosts: ['new.example.com'],
      repositories: ['org/repo', 'org/tools'],
    });
    expect(formatEnvironmentSetupDiff(diff)).toEqual([
      'Setup script changed',
      'Variables: +ADD, −REMOVE, ~CHANGE',
      'Secrets: +NEW_SECRET, −OLD_SECRET',
      'Sandbox: Default → larger',
      'Network: None → Limited (registry.example.com)',
      'Required hosts: +new.example.com, −old.example.com',
      'Repositories: +org/tools',
    ]);
    expect(formatEnvironmentSetupDiff(diff).join(' ')).not.toContain('private');
  });

  it('shows no changes for an unchanged configuration', () => {
    expect(formatEnvironmentSetupDiff(buildSetupRunDiff(baseline, baseline))).toEqual([]);
  });

  it('distinguishes Full network access from a restricted policy', () => {
    expect(
      formatEnvironmentSetupDiff(
        buildSetupRunDiff(baseline, { ...baseline, egressMode: 'unrestricted' })
      )
    ).toEqual(['Network: None → Full']);
  });

  it('formats observed setup durations', () => {
    expect(formatSetupDuration(280_000)).toBe('4m 40s');
    expect(formatSetupDuration(12_000)).toBe('12s');
  });

  it('links discovery and legacy evidence only to a matching setup or verification session', () => {
    const run = {
      cloudAgentSessionId: 'workspace-setup',
      kiloSessionId: 'kilo-setup',
      pendingVerification: { childSessionId: 'agent-pending', childKiloSessionId: 'kilo-pending' },
      lastVerification: { childSessionId: 'agent-last', childKiloSessionId: 'kilo-last' },
    } as SetupRunResponse;
    expect(setupTestChatId(run, 'workspace-setup')).toBe('kilo-setup');
    expect(setupTestChatId(run, 'agent-pending')).toBe('kilo-pending');
    expect(setupTestChatId(run, 'agent-last')).toBe('kilo-last');
    expect(setupTestChatId(run, 'unknown-agent')).toBeNull();
    expect(
      setupTestChatId(
        { ...run, lastVerification: { ...run.lastVerification!, childKiloSessionId: null } },
        'agent-last'
      )
    ).toBeNull();
  });
});
