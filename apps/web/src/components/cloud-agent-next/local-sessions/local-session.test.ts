import { describe, expect, it } from '@jest/globals';
import type { StoredSession } from '../types';
import { reconcileLocalSessions, withLocalSessions, type LocalSession } from './local-session';

const local: LocalSession = {
  kiloSessionId: 'ses_local',
  operationKey: '00000000-0000-4000-8000-000000000000',
  organizationId: null,
  worktreeId: 'worktree_a',
  request: { kind: 'worktree-chat', sourceKiloSessionId: 'ses_source' },
  repository: 'kilo/repo',
  branch: 'main',
  composer: null,
  firstMessage: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  sync: { state: 'syncing' },
};

function listed(sessionId: string): StoredSession {
  return {
    sessionId,
    repository: 'kilo/repo',
    prompt: 'Server title',
    mode: 'code',
    model: '',
    status: 'active',
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
    messages: [],
  };
}

describe('withLocalSessions', () => {
  it('keeps a local chat first through a refetch that does not list it yet', () => {
    const merged = withLocalSessions([listed('ses_old')], [local], null);

    expect(merged.map(session => [session.sessionId, session.localSync])).toEqual([
      ['ses_local', 'syncing'],
      ['ses_old', undefined],
    ]);
  });

  it('lets the server row win once it lists the same id', () => {
    const merged = withLocalSessions([listed('ses_local')], [local], null);

    expect(merged).toEqual([listed('ses_local')]);
  });

  it('ignores local chats of another organization', () => {
    expect(withLocalSessions([], [{ ...local, organizationId: 'org' }], null)).toEqual([]);
  });
});

describe('reconcileLocalSessions', () => {
  const synced: LocalSession = { ...local, sync: { state: 'synced' } };
  const failed: LocalSession = {
    ...local,
    sync: { state: 'failed', message: 'lost', retrySameAttempt: true, billingFailure: null },
  };
  const listed = new Set(['ses_local']);

  it('drops a listed synced session unless it is open', () => {
    expect(reconcileLocalSessions([synced], listed, null)).toEqual([]);
    expect(reconcileLocalSessions([synced], listed, 'ses_local')).toEqual([synced]);
  });

  it('treats a listed failure as synced, and leaves syncing and unlisted sessions', () => {
    expect(reconcileLocalSessions([failed], listed, 'ses_local')).toEqual([synced]);
    const pending = [local, failed];
    expect(reconcileLocalSessions(pending, new Set(), null)).toBe(pending);
    expect(reconcileLocalSessions([local], listed, null)).toEqual([local]);
  });
});
