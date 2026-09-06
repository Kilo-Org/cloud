import { describe, expect, it, vi } from 'vitest';
import {
  createInteractionRefresh,
  type InteractionRefreshScope,
} from './session-interaction-refresh';
import type { SessionSyncResult } from '../shared/sandbox-control-protocol';

const result: SessionSyncResult = { status: { type: 'busy' }, questions: [], permissions: [] };

function fixture() {
  let scope: InteractionRefreshScope | undefined = {
    message: { messageId: 'msg_1', state: 'accepted', wrapperInstanceId: 'wrapper_1' },
    epoch: 1,
    interactionRevision: 0,
    sessionId: 'session_1',
    sandboxId: 'sandbox_1',
    kiloSessionId: 'root_1',
    directory: '/workspace',
    worktreeId: undefined,
  };
  const sync = vi.fn(async (): Promise<SessionSyncResult | undefined> => result);
  const onBackgroundError = vi.fn();
  const refresh = createInteractionRefresh({ captureScope: () => scope, sync, onBackgroundError });
  return {
    refresh,
    sync,
    onBackgroundError,
    scope: () => scope,
    setScope: (next: typeof scope) => {
      scope = next;
    },
  };
}

describe('interaction refresh', () => {
  it('does not read without a current accepted scope', async () => {
    const f = fixture();
    const captured = f.scope();
    f.setScope(undefined);
    expect(await f.refresh.refresh(captured, 'accepted_alarm')).toBeUndefined();
    expect(f.sync).not.toHaveBeenCalled();
  });

  it('shares one actual read and its original promise across clients and watchdog', async () => {
    const f = fixture();
    const pending = Promise.withResolvers<SessionSyncResult>();
    f.sync.mockReturnValue(pending.promise);
    f.refresh.scheduleRefresh();
    const first = f.refresh.refresh(f.scope(), 'pending_interactions');
    const watchdog = f.refresh.refresh(f.scope(), 'accepted_alarm');
    expect(watchdog).toBe(first);
    await Promise.resolve();
    expect(f.sync).toHaveBeenCalledTimes(1);
    pending.resolve(result);
    expect(await watchdog).toBe(result);
  });

  it.each([
    'interactionRevision',
    'epoch',
    'sessionId',
    'sandboxId',
    'kiloSessionId',
    'directory',
    'worktreeId',
    'messageId',
    'wrapperInstanceId',
  ] as const)(
    'does not join old work after %s changes and old cleanup does not clear newer work',
    async field => {
      const f = fixture();
      const old = Promise.withResolvers<SessionSyncResult>();
      const next = Promise.withResolvers<SessionSyncResult>();
      f.sync.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const first = f.refresh.refresh(f.scope(), 'pending_interactions');
      await Promise.resolve();
      const scope = f.scope();
      if (!scope) throw new Error('Missing scope');
      f.setScope(
        field === 'messageId' || field === 'wrapperInstanceId'
          ? { ...scope, message: { ...scope.message, [field]: 'new' } }
          : { ...scope, [field]: typeof scope[field] === 'number' ? 2 : 'new' }
      );
      const second = f.refresh.refresh(f.scope(), 'pending_interactions');
      await Promise.resolve();
      old.resolve(result);
      await first;
      expect(f.refresh.refresh(f.scope(), 'accepted_alarm')).toBe(second);
      expect(f.sync).toHaveBeenCalledTimes(2);
      next.resolve(result);
      await second;
    }
  );

  it('preserves watchdog rejection while background scheduling handles it and can retry', async () => {
    const f = fixture();
    const pending = Promise.withResolvers<SessionSyncResult>();
    f.sync.mockReturnValueOnce(pending.promise);
    f.refresh.scheduleRefresh();
    const watchdog = f.refresh.refresh(f.scope(), 'accepted_alarm');
    const rejected = expect(watchdog).rejects.toThrow('sync failed');
    pending.reject(new Error('sync failed'));
    await rejected;
    expect(f.onBackgroundError).toHaveBeenCalledTimes(1);
    expect(await f.refresh.refresh(f.scope(), 'accepted_alarm')).toEqual(result);
    expect(f.sync).toHaveBeenCalledTimes(2);
  });

  it('does not convert a superseded result into failure', async () => {
    const f = fixture();
    f.sync.mockResolvedValue(undefined);
    expect(await f.refresh.refresh(f.scope(), 'accepted_alarm')).toBeUndefined();
    expect(f.onBackgroundError).not.toHaveBeenCalled();
  });
});
