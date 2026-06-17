import { describe, expect, it } from '@jest/globals';
import {
  getSecurityAgentActiveCommandState,
  getUnprocessedTerminalSecurityAgentCommands,
  mergeSecurityAgentActiveCommands,
  shouldRunSecurityAgentCommandSuccessCallback,
  type SecurityAgentCommand,
} from './SecurityAgentContext';
import { getSecurityAgentHelpContent, getSecurityAgentNavItems } from './SecurityAgentLayout';

function command(overrides: Partial<SecurityAgentCommand>): SecurityAgentCommand {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandType: 'sync',
    findingId: null,
    status: 'accepted',
    resultCode: null,
    lastErrorRedacted: null,
    ...overrides,
  };
}

describe('Security Agent help content', () => {
  const personalBasePath = '/security-agent';
  const organizationBasePath = '/organizations/org-1/security-agent';

  it.each([
    [personalBasePath, 'Dashboard help', '#use-the-dashboard'],
    [`${personalBasePath}/findings`, 'Findings help', '#browse-findings'],
    [`${personalBasePath}/audit-report`, 'Audit report help', '#audit-reports'],
    [`${personalBasePath}/config`, 'Settings help', '#configure-security-agent'],
  ])('matches personal route %s to its page help', (pathname, title, docsAnchor) => {
    const content = getSecurityAgentHelpContent(pathname, personalBasePath);

    expect(content.title).toBe(title);
    expect(content.docsUrl).toContain(docsAnchor);
  });

  it.each([
    [organizationBasePath, 'Dashboard help'],
    [`${organizationBasePath}/findings`, 'Findings help'],
    [`${organizationBasePath}/audit-report`, 'Audit report help'],
    [`${organizationBasePath}/config`, 'Settings help'],
  ])('matches organization route %s to its page help', (pathname, title) => {
    expect(getSecurityAgentHelpContent(pathname, organizationBasePath).title).toBe(title);
  });

  it('uses overview help outside known Security Agent routes', () => {
    expect(getSecurityAgentHelpContent('/security-agent/unknown', personalBasePath).title).toBe(
      'Security Agent help'
    );
    expect(getSecurityAgentHelpContent('/another-page', personalBasePath).title).toBe(
      'Security Agent help'
    );
  });
});

describe('Security Agent navigation', () => {
  const basePath = '/security-agent';

  it('keeps historical reports available during setup', () => {
    expect(
      getSecurityAgentNavItems({ basePath, showSetupOnly: true, isEnabled: undefined }).map(
        item => item.label
      )
    ).toEqual(['Audit report', 'Settings']);
  });

  it('preserves configured navigation', () => {
    expect(
      getSecurityAgentNavItems({ basePath, showSetupOnly: false, isEnabled: true }).map(
        item => item.label
      )
    ).toEqual(['Dashboard', 'Findings', 'Audit report', 'Settings']);
    expect(
      getSecurityAgentNavItems({ basePath, showSetupOnly: false, isEnabled: false }).map(
        item => item.label
      )
    ).toEqual(['Dashboard', 'Audit report', 'Settings']);
  });
});

describe('SecurityAgentContext command helpers', () => {
  it('recovers active commands after reload and dedupes polled state', () => {
    const recovered = command({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      commandType: 'sync',
      status: 'accepted',
    });
    const refreshed = command({
      id: recovered.id,
      commandType: 'sync',
      status: 'running',
    });
    const terminal = command({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      commandType: 'dismiss_finding',
      status: 'succeeded',
    });

    expect(mergeSecurityAgentActiveCommands([recovered], [refreshed, terminal])).toEqual([
      refreshed,
    ]);
  });

  it('removes recovered commands after polling observes a terminal state', () => {
    const recovered = command({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      commandType: 'start_analysis',
      findingId: 'finding-id',
      status: 'running',
    });
    const terminal = command({
      ...recovered,
      status: 'succeeded',
    });

    expect(mergeSecurityAgentActiveCommands([recovered], [terminal])).toEqual([]);
  });

  it('derives active-action disabling and optimistic analysis ids', () => {
    const state = getSecurityAgentActiveCommandState(
      [
        command({ id: 'sync-command', commandType: 'sync' }),
        command({ id: 'dismiss-command', commandType: 'dismiss_finding' }),
        command({
          id: 'analysis-command',
          commandType: 'start_analysis',
          findingId: 'finding-from-command',
        }),
      ],
      new Set(['optimistic-finding'])
    );

    expect(state.hasActiveSyncCommand).toBe(true);
    expect(state.hasActiveDismissCommand).toBe(true);
    expect([...state.startingAnalysisIds].sort()).toEqual([
      'finding-from-command',
      'optimistic-finding',
    ]);
  });

  it('settles each terminal command once', () => {
    const failed = command({
      id: 'failed-command',
      status: 'failed',
      resultCode: 'GITHUB_AUTH_INVALID',
    });
    const alreadyProcessed = command({
      id: 'processed-command',
      status: 'succeeded',
      resultCode: 'SYNC_COMPLETED',
    });
    const active = command({ id: 'active-command', status: 'running' });

    expect(
      getUnprocessedTerminalSecurityAgentCommands(
        [failed, alreadyProcessed, active, undefined],
        new Set([alreadyProcessed.id])
      )
    ).toEqual([failed]);
  });

  it('runs dismissal success callbacks only after successful terminal states', () => {
    expect(shouldRunSecurityAgentCommandSuccessCallback(command({ status: 'accepted' }))).toBe(
      false
    );
    expect(shouldRunSecurityAgentCommandSuccessCallback(command({ status: 'running' }))).toBe(
      false
    );
    expect(shouldRunSecurityAgentCommandSuccessCallback(command({ status: 'failed' }))).toBe(false);
    expect(shouldRunSecurityAgentCommandSuccessCallback(command({ status: 'succeeded' }))).toBe(
      true
    );
    expect(shouldRunSecurityAgentCommandSuccessCallback(command({ status: 'no_op' }))).toBe(true);
  });
});
