import { describe, expect, it } from '@jest/globals';
import {
  getSecurityAgentActiveCommandState,
  getUnprocessedTerminalSecurityAgentCommands,
  mergeSecurityAgentActiveCommands,
  shouldRunSecurityAgentCommandSuccessCallback,
  type SecurityAgentCommand,
} from './SecurityAgentContext';

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
