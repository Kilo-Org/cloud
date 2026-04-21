import { createServiceState } from './service-state';
import type { ServiceStateConfig } from './service-state';
import type { Session, QuestionInfo } from '@/types/opencode.gen';

function makeConfig(overrides?: Partial<ServiceStateConfig>): ServiceStateConfig {
  return { rootSessionId: 'root-1', ...overrides };
}

function makeSession(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: 'proj-1',
    directory: '/tmp',
    title: 'Test Session',
    version: '1',
    time: { created: Date.now(), updated: Date.now() },
    ...(parentID ? { parentID } : {}),
  } as Session;
}

describe('createServiceState', () => {
  describe('initial state', () => {
    it('starts with connecting activity, idle status, no question, no permission', () => {
      const state = createServiceState(makeConfig());

      expect(state.getActivity()).toEqual({ type: 'connecting' });
      expect(state.getStatus()).toEqual({ type: 'idle' });
      expect(state.getQuestion()).toBeNull();
      expect(state.getPermission()).toBeNull();
      expect(state.getSessionInfo()).toBeNull();
    });

    it('snapshot returns all initial state', () => {
      const state = createServiceState(makeConfig());
      const snap = state.snapshot();

      expect(snap.activity).toEqual({ type: 'connecting' });
      expect(snap.status).toEqual({ type: 'idle' });
      expect(snap.cloudStatus).toBeNull();
      expect(snap.sessionInfo).toBeNull();
      expect(snap.question).toBeNull();
      expect(snap.permission).toBeNull();
    });
  });

  describe('session.status', () => {
    it('busy on root session sets activity to busy and resets status to idle', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      expect(state.getActivity()).toEqual({ type: 'busy' });
      expect(state.getStatus()).toEqual({ type: 'idle' });
    });

    it('busy on non-root session does not change activity', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'session.status', sessionId: 'unknown-1', status: { type: 'busy' } });

      // Non-root session doesn't affect activity
      expect(state.getActivity()).toEqual({ type: 'connecting' });
    });

    it('busy on child session does not change activity', () => {
      const state = createServiceState(makeConfig());
      state.setActivity({ type: 'busy' });

      state.process({ type: 'session.status', sessionId: 'child-1', status: { type: 'busy' } });

      // Activity remains busy (set manually above), not changed by child
      expect(state.getActivity()).toEqual({ type: 'busy' });
    });

    it('busy on child does not reset status', () => {
      const state = createServiceState(makeConfig());
      state.setStatus({ type: 'error', message: 'previous error' });

      state.process({ type: 'session.status', sessionId: 'child-1', status: { type: 'busy' } });

      expect(state.getStatus()).toEqual({ type: 'error', message: 'previous error' });
    });

    it('retry sets activity to retrying with attempt and message', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'session.status',
        sessionId: 'root-1',
        status: { type: 'retry', attempt: 3, message: 'Rate limited', next: 5000 },
      });

      expect(state.getActivity()).toEqual({
        type: 'retrying',
        attempt: 3,
        message: 'Rate limited',
      });
    });

    it('idle status on root transitions busy to idle', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'idle' } });

      expect(state.getActivity()).toEqual({ type: 'idle' });
    });

    it('idle status on child does not change root activity', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      state.process({ type: 'session.status', sessionId: 'child-1', status: { type: 'idle' } });

      expect(state.getActivity()).toEqual({ type: 'busy' });
    });

    it('idle status on root transitions any non-idle activity to idle', () => {
      const state = createServiceState(makeConfig());
      // Activity starts as 'connecting'
      expect(state.getActivity()).toEqual({ type: 'connecting' });

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'idle' } });

      expect(state.getActivity()).toEqual({ type: 'idle' });
    });

    it('busy on root resets status to idle (new turn clears previous error)', () => {
      const state = createServiceState(makeConfig());
      state.setStatus({ type: 'error', message: 'old error' });

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      expect(state.getStatus()).toEqual({ type: 'idle' });
    });

    it('busy on root resets status to idle (clears interrupted)', () => {
      const state = createServiceState(makeConfig());
      state.setStatus({ type: 'interrupted' });

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      expect(state.getStatus()).toEqual({ type: 'idle' });
    });
  });

  describe('stopped', () => {
    it('complete sets activity to idle and fires onBranchChanged with branch', () => {
      const onBranchChanged = jest.fn();
      const state = createServiceState(makeConfig({ onBranchChanged }));
      state.setActivity({ type: 'busy' });

      state.process({ type: 'stopped', reason: 'complete', branch: 'main' });

      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'idle' });
      expect(onBranchChanged).toHaveBeenCalledWith('main');
    });

    it('complete without branch does not fire onBranchChanged', () => {
      const onBranchChanged = jest.fn();
      const state = createServiceState(makeConfig({ onBranchChanged }));

      state.process({ type: 'stopped', reason: 'complete' });

      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(onBranchChanged).not.toHaveBeenCalled();
    });

    it('complete preserves autocommit completed status', () => {
      const state = createServiceState(makeConfig());
      state.setStatus({
        type: 'autocommit',
        step: 'completed',
        message: 'abc fix',
      });

      state.process({ type: 'stopped', reason: 'complete' });

      expect(state.getStatus()).toEqual({
        type: 'autocommit',
        step: 'completed',
        message: 'abc fix',
      });
    });

    it('interrupted sets activity to idle and status to interrupted', () => {
      const state = createServiceState(makeConfig());
      state.setActivity({ type: 'busy' });

      state.process({ type: 'stopped', reason: 'interrupted' });

      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'interrupted' });
    });

    it('error sets activity to idle, status to error, and fires onError', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));
      state.setActivity({ type: 'busy' });

      state.process({ type: 'stopped', reason: 'error' });

      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'error', message: 'Session terminated' });
      expect(onError).toHaveBeenCalledWith('Session terminated');
    });

    it('disconnected sets activity to idle, status to disconnected, and fires onError', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));
      state.setActivity({ type: 'busy' });

      state.process({ type: 'stopped', reason: 'disconnected' });

      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'disconnected' });
      expect(onError).toHaveBeenCalledWith('Connection to agent lost');
    });

    it('stopped resets cloudStatus to null when it was preparing', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'preparing', step: 'cloning', message: 'Cloning...' },
      });
      expect(state.getCloudStatus()).not.toBeNull();

      state.process({ type: 'stopped', reason: 'error' });

      expect(state.getCloudStatus()).toBeNull();
    });

    it('stopped resets cloudStatus to null when it was finalizing', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'finalizing', step: 'committing', message: 'Committing...' },
      });
      expect(state.getCloudStatus()).not.toBeNull();

      state.process({ type: 'stopped', reason: 'complete' });

      expect(state.getCloudStatus()).toBeNull();
    });

    it('stopped resets cloudStatus to null on disconnected', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'preparing', step: 'cloning', message: 'Cloning...' },
      });
      expect(state.getCloudStatus()).not.toBeNull();

      state.process({ type: 'stopped', reason: 'disconnected' });

      expect(state.getCloudStatus()).toBeNull();
    });
  });

  describe('session.error', () => {
    it('fires onError before stopped', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      state.process({ type: 'session.error', error: 'Something went wrong' });

      expect(onError).toHaveBeenCalledWith('Something went wrong');
      expect(state.getStatus()).toEqual({ type: 'error', message: 'Something went wrong' });
    });

    it('is suppressed after stopped(error) — aftershock absorption', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      state.process({ type: 'stopped', reason: 'error' });
      onError.mockClear();

      state.process({ type: 'session.error', error: 'Aftershock error' });

      expect(onError).not.toHaveBeenCalled();
    });

    it('is suppressed after stopped(interrupted)', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      state.process({ type: 'stopped', reason: 'interrupted' });
      onError.mockClear();

      state.process({ type: 'session.error', error: 'Aftershock' });

      expect(onError).not.toHaveBeenCalled();
    });

    it('is suppressed after stopped(disconnected)', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      state.process({ type: 'stopped', reason: 'disconnected' });
      onError.mockClear();

      state.process({ type: 'session.error', error: 'Aftershock' });

      expect(onError).not.toHaveBeenCalled();
    });

    it('is allowed again after new busy resets terminated flag', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      // First turn: error + stopped
      state.process({ type: 'stopped', reason: 'error' });
      onError.mockClear();

      // New turn: busy resets terminated
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      // session.error should now fire
      state.process({ type: 'session.error', error: 'New error' });

      expect(onError).toHaveBeenCalledWith('New error');
      expect(state.getStatus()).toEqual({ type: 'error', message: 'New error' });
    });
  });

  describe('session.created', () => {
    it('fires onSessionCreated and stores sessionInfo for root sessions', () => {
      const onSessionCreated = jest.fn();
      const state = createServiceState(makeConfig({ onSessionCreated }));
      const info = makeSession('root-1');

      state.process({ type: 'session.created', info });

      expect(onSessionCreated).toHaveBeenCalledWith(info);
      expect(state.getSessionInfo()).toBe(info);
    });

    it('fires onSessionCreated but does not store sessionInfo for child sessions', () => {
      const onSessionCreated = jest.fn();
      const state = createServiceState(makeConfig({ onSessionCreated }));
      const childInfo = makeSession('child-1', 'root-1');

      state.process({ type: 'session.created', info: childInfo });

      expect(onSessionCreated).toHaveBeenCalledWith(childInfo);
      expect(state.getSessionInfo()).toBeNull();
    });
  });

  describe('session.updated', () => {
    it('fires onSessionUpdated and updates sessionInfo for root sessions', () => {
      const onSessionUpdated = jest.fn();
      const state = createServiceState(makeConfig({ onSessionUpdated }));
      const info = makeSession('root-1');

      state.process({ type: 'session.updated', info });

      expect(onSessionUpdated).toHaveBeenCalledWith(info);
      expect(state.getSessionInfo()).toBe(info);
    });

    it('fires onSessionUpdated but does not update sessionInfo for child sessions', () => {
      const onSessionUpdated = jest.fn();
      const state = createServiceState(makeConfig({ onSessionUpdated }));

      const rootInfo = makeSession('root-1');
      state.process({ type: 'session.created', info: rootInfo });

      const childInfo = makeSession('child-1', 'root-1');
      state.process({ type: 'session.updated', info: childInfo });

      expect(onSessionUpdated).toHaveBeenCalledWith(childInfo);
      expect(state.getSessionInfo()).toBe(rootInfo);
    });
  });

  describe('question.asked', () => {
    it('sets question state and fires callback', () => {
      const onQuestionAsked = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionAsked }));
      const questions: QuestionInfo[] = [
        { question: 'Allow?', header: 'Permission', options: [{ label: 'Yes', description: '' }] },
      ];

      state.process({
        type: 'question.asked',
        requestId: 'req-1',
        questions,
      });

      expect(state.getQuestion()).toEqual({
        requestId: 'req-1',
        questions,
      });
      expect(onQuestionAsked).toHaveBeenCalledWith('req-1', questions);
    });

    it('sets question state without questions (standalone question)', () => {
      const onQuestionAsked = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionAsked }));

      state.process({ type: 'question.asked', requestId: 'req-2' });

      expect(state.getQuestion()).toEqual({
        requestId: 'req-2',
        questions: undefined,
      });
      expect(onQuestionAsked).toHaveBeenCalledWith('req-2', undefined);
    });
  });

  describe('question.replied', () => {
    it('clears question and fires onQuestionResolved', () => {
      const onQuestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionResolved }));

      state.process({ type: 'question.asked', requestId: 'req-1' });
      state.process({ type: 'question.replied', requestId: 'req-1' });

      expect(state.getQuestion()).toBeNull();
      expect(onQuestionResolved).toHaveBeenCalledWith('req-1');
    });
  });

  describe('question.rejected', () => {
    it('clears question and fires onQuestionResolved', () => {
      const onQuestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionResolved }));

      state.process({ type: 'question.asked', requestId: 'req-1' });
      state.process({ type: 'question.rejected', requestId: 'req-1' });

      expect(state.getQuestion()).toBeNull();
      expect(onQuestionResolved).toHaveBeenCalledWith('req-1');
    });
  });

  describe('preparing', () => {
    it('normal step sets cloudStatus to preparing', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'preparing', step: 'cloning', message: 'Cloning repository...' });

      expect(state.getCloudStatus()).toEqual({
        type: 'preparing',
        step: 'cloning',
        message: 'Cloning repository...',
      });
    });

    it('step ready fires onPreparationReady and sets cloudStatus to ready', () => {
      const onPreparationReady = jest.fn();
      const state = createServiceState(makeConfig({ onPreparationReady }));

      state.process({ type: 'preparing', step: 'ready', message: 'Ready' });

      expect(state.getCloudStatus()).toEqual({ type: 'ready' });
      expect(onPreparationReady).toHaveBeenCalledTimes(1);
    });

    it('step failed fires onPreparationFailed and onError, sets cloudStatus to error', () => {
      const onPreparationFailed = jest.fn();
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onPreparationFailed, onError }));

      state.process({ type: 'preparing', step: 'failed', message: 'Clone failed' });

      expect(state.getCloudStatus()).toEqual({ type: 'error', message: 'Clone failed' });
      expect(onError).toHaveBeenCalledWith('Clone failed');
      expect(onPreparationFailed).toHaveBeenCalledWith('Clone failed');
    });
  });

  describe('cloud.status', () => {
    it('cloudStatus defaults to null in initial snapshot', () => {
      const state = createServiceState(makeConfig());
      expect(state.getCloudStatus()).toBeNull();
      expect(state.snapshot().cloudStatus).toBeNull();
    });

    it('preparing sets cloudStatus', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'preparing', step: 'cloning', message: 'Cloning...' },
      });
      expect(state.getCloudStatus()).toEqual({
        type: 'preparing',
        step: 'cloning',
        message: 'Cloning...',
      });
    });

    it('ready sets cloudStatus', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'cloud.status', cloudStatus: { type: 'ready' } });
      expect(state.getCloudStatus()).toEqual({ type: 'ready' });
    });

    it('finalizing sets cloudStatus', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'finalizing', step: 'committing', message: 'Committing...' },
      });
      expect(state.getCloudStatus()).toEqual({
        type: 'finalizing',
        step: 'committing',
        message: 'Committing...',
      });
    });

    it('error sets cloudStatus', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'cloud.status',
        cloudStatus: { type: 'error', message: 'Sandbox failed' },
      });
      expect(state.getCloudStatus()).toEqual({ type: 'error', message: 'Sandbox failed' });
    });

    it('reset clears cloudStatus back to null', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'cloud.status', cloudStatus: { type: 'ready' } });
      state.reset();
      expect(state.getCloudStatus()).toBeNull();
    });

    it('subscribers notified on cloudStatus changes', () => {
      const state = createServiceState(makeConfig());
      const cb = jest.fn();
      state.subscribe(cb);
      state.process({ type: 'cloud.status', cloudStatus: { type: 'ready' } });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('setCloudStatus directly updates cloudStatus', () => {
      const state = createServiceState(makeConfig());
      state.setCloudStatus({ type: 'preparing', step: 'cloning' });
      expect(state.getCloudStatus()).toEqual({ type: 'preparing', step: 'cloning' });
    });

    it('setCloudStatus to null clears it', () => {
      const state = createServiceState(makeConfig());
      state.setCloudStatus({ type: 'ready' });
      state.setCloudStatus(null);
      expect(state.getCloudStatus()).toBeNull();
    });
  });

  describe('connected', () => {
    it('sets activity from sessionStatus busy', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'connected', sessionStatus: { type: 'busy' } });
      expect(state.getActivity()).toEqual({ type: 'busy' });
    });

    it('sets activity from sessionStatus idle', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(state.getActivity()).toEqual({ type: 'idle' });
    });

    it('defaults activity to idle when sessionStatus is absent', () => {
      const state = createServiceState(makeConfig());
      // Verify we start in 'connecting'
      expect(state.getActivity()).toEqual({ type: 'connecting' });
      // Connected event without sessionStatus (server has no execution-derived state)
      state.process({ type: 'connected' });
      expect(state.getActivity()).toEqual({ type: 'idle' });
    });

    it('sets cloudStatus when provided', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'connected',
        sessionStatus: { type: 'idle' },
        cloudStatus: { type: 'preparing', step: 'cloning' },
      });
      expect(state.getCloudStatus()).toEqual({ type: 'preparing', step: 'cloning' });
    });

    it('leaves cloudStatus as null when not provided', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(state.getCloudStatus()).toBeNull();
    });

    it('clears question when not provided on reconnect', () => {
      const state = createServiceState(makeConfig());
      // Set a question via question.asked
      state.process({ type: 'question.asked', requestId: 'req-stale' });
      expect(state.getQuestion()).not.toBeNull();
      // Reconnect without question — it was answered while disconnected
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(state.getQuestion()).toBeNull();
    });

    it('clears permission when not provided on reconnect', () => {
      const state = createServiceState(makeConfig());
      // Set a permission via permission.asked
      state.process({
        type: 'permission.asked',
        requestId: 'perm-stale',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
      expect(state.getPermission()).not.toBeNull();
      // Reconnect without permission — it was resolved while disconnected
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(state.getPermission()).toBeNull();
    });

    it('fires onQuestionResolved when clearing stale question on reconnect', () => {
      const onQuestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionResolved }));
      // Set a question
      state.process({ type: 'question.asked', requestId: 'req-stale' });
      onQuestionResolved.mockClear();
      // Reconnect — question was answered while disconnected
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(onQuestionResolved).toHaveBeenCalledWith('req-stale');
    });

    it('fires onPermissionResolved when clearing stale permission on reconnect', () => {
      const onPermissionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onPermissionResolved }));
      // Set a permission
      state.process({
        type: 'permission.asked',
        requestId: 'perm-stale',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
      onPermissionResolved.mockClear();
      // Reconnect — permission was resolved while disconnected
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(onPermissionResolved).toHaveBeenCalledWith('perm-stale');
    });

    it('does not fire resolve callbacks when no question/permission was pending', () => {
      const onQuestionResolved = jest.fn();
      const onPermissionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onQuestionResolved, onPermissionResolved }));
      // Connect with no prior question/permission
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      expect(onQuestionResolved).not.toHaveBeenCalled();
      expect(onPermissionResolved).not.toHaveBeenCalled();
    });

    it('clears terminated flag', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));
      // Terminate
      state.process({ type: 'stopped', reason: 'error' });
      onError.mockClear();
      // Connect
      state.process({ type: 'connected', sessionStatus: { type: 'idle' } });
      // session.error should fire again
      state.process({ type: 'session.error', error: 'New error' });
      expect(onError).toHaveBeenCalledWith('New error');
    });

    it('sets all fields in one shot', () => {
      const state = createServiceState(makeConfig());
      state.process({
        type: 'connected',
        sessionStatus: { type: 'busy' },
        cloudStatus: { type: 'ready' },
      });
      expect(state.getActivity()).toEqual({ type: 'busy' });
      expect(state.getCloudStatus()).toEqual({ type: 'ready' });
    });

    it('notifies subscribers once', () => {
      const state = createServiceState(makeConfig());
      const cb = jest.fn();
      state.subscribe(cb);
      state.process({
        type: 'connected',
        sessionStatus: { type: 'idle' },
        cloudStatus: { type: 'ready' },
      });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('autocommit_started', () => {
    it('sets status to autocommit started', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'autocommit_started',
        messageId: 'msg-1',
        message: 'Committing changes...',
      });

      expect(state.getStatus()).toEqual({
        type: 'autocommit',
        step: 'started',
        message: 'Committing changes...',
      });
    });

    it('defaults message to Committing… when omitted', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'autocommit_started', messageId: 'msg-1' });

      expect(state.getStatus()).toEqual({
        type: 'autocommit',
        step: 'started',
        message: 'Committing…',
      });
    });
  });

  describe('autocommit_completed', () => {
    it('success sets status to autocommit completed', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'autocommit_started', messageId: 'msg-1', message: 'Committing...' });
      state.process({
        type: 'autocommit_completed',
        messageId: 'msg-1',
        success: true,
        commitHash: 'abc123',
        commitMessage: 'feat: add feature',
      });

      expect(state.getStatus()).toEqual({
        type: 'autocommit',
        step: 'completed',
        message: 'abc123 feat: add feature',
      });
    });

    it('failure sets status to autocommit failed', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'autocommit_started', messageId: 'msg-1', message: 'Committing...' });
      state.process({
        type: 'autocommit_completed',
        messageId: 'msg-1',
        success: false,
        message: 'Git conflict',
      });

      expect(state.getStatus()).toEqual({
        type: 'autocommit',
        step: 'failed',
        message: 'Git conflict',
      });
    });

    it('skipped does not update status', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'autocommit_started', messageId: 'msg-1', message: 'Committing...' });

      const statusBefore = state.getStatus();

      state.process({
        type: 'autocommit_completed',
        messageId: 'msg-1',
        success: false,
        skipped: true,
      });

      expect(state.getStatus()).toBe(statusBefore);
    });
  });

  describe('no-op events', () => {
    it('session.idle does not change state', () => {
      const state = createServiceState(makeConfig());
      const before = state.snapshot();

      state.process({ type: 'session.idle', sessionId: 'root-1' });

      expect(state.snapshot()).toEqual(before);
    });

    it('session.turn.close does not change state', () => {
      const state = createServiceState(makeConfig());
      const before = state.snapshot();

      state.process({ type: 'session.turn.close', sessionId: 'root-1', reason: 'done' });

      expect(state.snapshot()).toEqual(before);
    });

    it('warning does not change state', () => {
      const state = createServiceState(makeConfig());
      const before = state.snapshot();

      state.process({ type: 'warning' });

      expect(state.snapshot()).toEqual(before);
    });
  });

  describe('subscribe', () => {
    it('fires callback on state changes', () => {
      const state = createServiceState(makeConfig());
      const callback = jest.fn();
      state.subscribe(callback);

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires callback on setActivity', () => {
      const state = createServiceState(makeConfig());
      const callback = jest.fn();
      state.subscribe(callback);

      state.setActivity({ type: 'idle' });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires callback on setStatus', () => {
      const state = createServiceState(makeConfig());
      const callback = jest.fn();
      state.subscribe(callback);

      state.setStatus({ type: 'disconnected' });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops callbacks', () => {
      const state = createServiceState(makeConfig());
      const callback = jest.fn();
      const unsubscribe = state.subscribe(callback);

      unsubscribe();
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });

      expect(callback).not.toHaveBeenCalled();
    });

    it('multiple subscribers all fire', () => {
      const state = createServiceState(makeConfig());
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      state.subscribe(cb1);
      state.subscribe(cb2);

      state.process({ type: 'stopped', reason: 'complete' });

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('returns to initial state', () => {
      const state = createServiceState(makeConfig());

      // Mutate all state
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      state.process({
        type: 'session.created',
        info: makeSession('root-1'),
      });
      state.process({ type: 'question.asked', requestId: 'req-1' });
      state.process({ type: 'autocommit_started', messageId: 'msg-1', message: 'committing' });
      state.process({ type: 'stopped', reason: 'error' });

      state.reset();

      expect(state.getActivity()).toEqual({ type: 'connecting' });
      expect(state.getStatus()).toEqual({ type: 'idle' });
      expect(state.getCloudStatus()).toBeNull();
      expect(state.getQuestion()).toBeNull();
      expect(state.getSessionInfo()).toBeNull();
    });

    it('clears terminated flag so session.error fires again', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      state.process({ type: 'stopped', reason: 'error' });
      onError.mockClear();

      state.reset();

      state.process({ type: 'session.error', error: 'New error after reset' });
      expect(onError).toHaveBeenCalledWith('New error after reset');
    });

    it('fires subscribers', () => {
      const state = createServiceState(makeConfig());
      const callback = jest.fn();
      state.subscribe(callback);

      state.reset();

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('setActivity / setStatus', () => {
    it('setActivity directly updates activity', () => {
      const state = createServiceState(makeConfig());

      state.setActivity({ type: 'busy' });

      expect(state.getActivity()).toEqual({ type: 'busy' });
    });

    it('setStatus directly updates status', () => {
      const state = createServiceState(makeConfig());

      state.setStatus({ type: 'disconnected' });

      expect(state.getStatus()).toEqual({ type: 'disconnected' });
    });

    it('setActivity with retrying', () => {
      const state = createServiceState(makeConfig());

      state.setActivity({ type: 'retrying', attempt: 2, message: 'Reconnecting...' });

      expect(state.getActivity()).toEqual({
        type: 'retrying',
        attempt: 2,
        message: 'Reconnecting...',
      });
    });
  });

  describe('multi-turn lifecycle', () => {
    it('busy → complete → busy again resets terminated flag and allows new turn', () => {
      const onError = jest.fn();
      const state = createServiceState(makeConfig({ onError }));

      // Turn 1: busy → error stopped
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      state.process({ type: 'stopped', reason: 'error' });
      expect(state.getStatus()).toEqual({ type: 'error', message: 'Session terminated' });

      // Turn 2: busy resets everything
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      expect(state.getActivity()).toEqual({ type: 'busy' });
      expect(state.getStatus()).toEqual({ type: 'idle' });

      // session.error now works again
      onError.mockClear();
      state.process({ type: 'session.error', error: 'Turn 2 error' });
      expect(onError).toHaveBeenCalledWith('Turn 2 error');
    });

    it('busy → interrupted → busy → complete with branch', () => {
      const onBranchChanged = jest.fn();
      const state = createServiceState(makeConfig({ onBranchChanged }));

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      state.process({ type: 'stopped', reason: 'interrupted' });
      expect(state.getStatus()).toEqual({ type: 'interrupted' });

      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      expect(state.getStatus()).toEqual({ type: 'idle' });

      state.process({ type: 'stopped', reason: 'complete', branch: 'feature/new' });
      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(onBranchChanged).toHaveBeenCalledWith('feature/new');
    });
  });

  describe('permission.asked', () => {
    it('tracks permission state on permission.asked', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['src/**/*.ts'],
        metadata: { reason: 'code generation' },
        always: ['read'],
      });

      expect(state.getPermission()).toEqual({
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['src/**/*.ts'],
        metadata: { reason: 'code generation' },
        always: ['read'],
      });
    });

    it('fires onPermissionAsked callback', () => {
      const onPermissionAsked = jest.fn();
      const state = createServiceState(makeConfig({ onPermissionAsked }));

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['src/**/*.ts'],
        metadata: { reason: 'code generation' },
        always: ['read'],
      });

      expect(onPermissionAsked).toHaveBeenCalledWith(
        'perm-1',
        'file-edit',
        ['src/**/*.ts'],
        { reason: 'code generation' },
        ['read']
      );
    });

    it('includes permission in snapshot', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });

      expect(state.snapshot().permission).toEqual({
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
    });
  });

  describe('permission.replied', () => {
    it('clears permission state on permission.replied', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
      expect(state.getPermission()).not.toBeNull();

      state.process({ type: 'permission.replied', requestId: 'perm-1' });

      expect(state.getPermission()).toBeNull();
    });

    it('fires onPermissionResolved callback', () => {
      const onPermissionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onPermissionResolved }));

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
      state.process({ type: 'permission.replied', requestId: 'perm-1' });

      expect(onPermissionResolved).toHaveBeenCalledWith('perm-1');
    });
  });

  describe('reset permission', () => {
    it('clears permission on reset', () => {
      const state = createServiceState(makeConfig());

      state.process({
        type: 'permission.asked',
        requestId: 'perm-1',
        permission: 'file-edit',
        patterns: ['**/*'],
        metadata: {},
        always: [],
      });
      expect(state.getPermission()).not.toBeNull();

      state.reset();

      expect(state.getPermission()).toBeNull();
    });
  });

  describe('suggestion.shown', () => {
    it('sets suggestion state and fires onSuggestionAsked', () => {
      const onSuggestionAsked = jest.fn();
      const state = createServiceState(makeConfig({ onSuggestionAsked }));
      const actions = [
        { label: 'Review', prompt: '/local-review' },
        { label: 'Skip', prompt: 'no thanks' },
      ];

      state.process({
        type: 'suggestion.shown',
        requestId: 'sug-1',
        text: 'Review?',
        actions,
        callId: 'call-1',
      });

      expect(state.getSuggestion()).toEqual({
        requestId: 'sug-1',
        text: 'Review?',
        actions,
        callId: 'call-1',
      });
      expect(onSuggestionAsked).toHaveBeenCalledWith('sug-1', 'Review?', actions, 'call-1');
    });
  });

  describe('suggestion.accepted', () => {
    it('clears suggestion and fires onSuggestionResolved', () => {
      const onSuggestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onSuggestionResolved }));

      state.process({ type: 'suggestion.shown', requestId: 'sug-1', text: 't', actions: [] });
      state.process({ type: 'suggestion.accepted', requestId: 'sug-1', index: 0 });

      expect(state.getSuggestion()).toBeNull();
      expect(onSuggestionResolved).toHaveBeenCalledWith('sug-1');
    });

    it('second matching resolve is fully a no-op (callback fires exactly once)', () => {
      const onSuggestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onSuggestionResolved }));

      state.process({ type: 'suggestion.shown', requestId: 'sug-1', text: 't', actions: [] });
      state.process({ type: 'suggestion.accepted', requestId: 'sug-1', index: 0 });
      state.process({ type: 'suggestion.dismissed', requestId: 'sug-1' });

      expect(state.getSuggestion()).toBeNull();
      expect(onSuggestionResolved).toHaveBeenCalledTimes(1);
      expect(onSuggestionResolved).toHaveBeenCalledWith('sug-1');
    });

    it('resolve with mismatched requestId does not clear state', () => {
      const state = createServiceState(makeConfig());

      state.process({ type: 'suggestion.shown', requestId: 'sug-1', text: 't', actions: [] });
      state.process({ type: 'suggestion.accepted', requestId: 'other', index: 0 });

      expect(state.getSuggestion()).toEqual({
        requestId: 'sug-1',
        text: 't',
        actions: [],
      });
    });
  });

  describe('suggestion.dismissed', () => {
    it('clears suggestion and fires onSuggestionResolved', () => {
      const onSuggestionResolved = jest.fn();
      const state = createServiceState(makeConfig({ onSuggestionResolved }));

      state.process({ type: 'suggestion.shown', requestId: 'sug-1', text: 't', actions: [] });
      state.process({ type: 'suggestion.dismissed', requestId: 'sug-1' });

      expect(state.getSuggestion()).toBeNull();
      expect(onSuggestionResolved).toHaveBeenCalledWith('sug-1');
    });
  });

  describe('reset suggestion', () => {
    it('clears suggestion on reset', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'suggestion.shown', requestId: 'sug-1', text: 't', actions: [] });
      expect(state.getSuggestion()).not.toBeNull();

      state.reset();

      expect(state.getSuggestion()).toBeNull();
    });
  });

  describe('child session detection', () => {
    it('root session busy changes activity', () => {
      const state = createServiceState(makeConfig());
      state.process({ type: 'session.status', sessionId: 'root-1', status: { type: 'busy' } });
      expect(state.getActivity()).toEqual({ type: 'busy' });
    });

    it('non-root session busy does not change activity', () => {
      const state = createServiceState(makeConfig());
      state.setActivity({ type: 'connecting' });
      state.process({ type: 'session.status', sessionId: 'child-1', status: { type: 'busy' } });
      expect(state.getActivity()).toEqual({ type: 'connecting' });
    });
  });
});
