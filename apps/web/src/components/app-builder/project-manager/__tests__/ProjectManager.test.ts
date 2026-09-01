import type { StoredMessage } from '@/components/cloud-agent-next/types';
import type { ProjectWithMessages } from '@/lib/app-builder/types';
import { createProjectManager, type ProjectManagerConfig } from '../../ProjectManager';
import { createSessionStore, type SessionStore } from '../sessions/session-store';
import { createV1Session } from '../sessions/v1/v1-session';
import { createV2Session, type CreateV2SessionConfig } from '../sessions/v2/v2-session';
import type { V2Session } from '../sessions/types';

jest.mock('../preview-polling', () => ({
  startPreviewPolling: jest.fn(() => ({ isPolling: true, stop: jest.fn() })),
}));
jest.mock('../deployments', () => ({ deploy: jest.fn() }));
jest.mock('../sessions/v1/v1-session', () => ({ createV1Session: jest.fn() }));
jest.mock('../sessions/v2/v2-session', () => ({ createV2Session: jest.fn() }));

type TestSession = V2Session & {
  store: SessionStore<StoredMessage>;
  capturedListeners: Array<() => void>;
};

const createdSessions: TestSession[] = [];
const mockCreateV1Session = jest.mocked(createV1Session);
const mockCreateV2Session = jest.mocked(createV2Session);

function createTestSession(config: CreateV2SessionConfig): TestSession {
  const store = createSessionStore(config.initialMessages);
  const capturedListeners: Array<() => void> = [];
  const session: TestSession = {
    type: 'v2',
    info: config.info,
    getState: store.getState,
    subscribe: listener => {
      capturedListeners.push(listener);
      return store.subscribe(listener);
    },
    getChildSessionMessages: store.getChildSessionMessages,
    sendMessage: jest.fn(async () => {}),
    interrupt: jest.fn(async () => {}),
    startInitialStreaming: jest.fn(),
    connectToExistingSession: jest.fn(() => store.setState({ isConnecting: true })),
    loadMessages: jest.fn(),
    destroy: jest.fn(),
    store,
    capturedListeners,
  };
  createdSessions.push(session);
  return session;
}

function createProject(): ProjectWithMessages {
  return {
    id: 'project-1',
    session_id: 'session-old',
    deployment_id: null,
    model_id: null,
    git_repo_full_name: null,
    messages: [],
    sessions: [
      {
        id: 'session-old',
        cloud_agent_session_id: 'session-old',
        worker_version: 'v2',
        ended_at: null,
        title: null,
        initiated: true,
        prepared: true,
      },
    ],
  } as unknown as ProjectWithMessages;
}

function createTrpcClient(sendMessage: jest.Mock = jest.fn()) {
  return {
    appBuilder: {
      sendMessage: { mutate: sendMessage },
      interruptSession: { mutate: jest.fn(async () => ({ success: true })) },
    },
    organizations: {
      appBuilder: {
        sendMessage: { mutate: jest.fn() },
        interruptSession: { mutate: jest.fn(async () => ({ success: true })) },
      },
    },
  };
}

function createManager(
  sendMessage: jest.Mock = jest.fn(),
  project: ProjectWithMessages = createProject()
) {
  const trpcClient = createTrpcClient(sendMessage);
  const manager = createProjectManager({
    project,
    organizationId: null,
    trpcClient: trpcClient as unknown as ProjectManagerConfig['trpcClient'],
  });
  return { manager, trpcClient };
}

function flushNotifications(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('ProjectManager session handoff', () => {
  beforeEach(() => {
    createdSessions.length = 0;
    jest.clearAllMocks();
    mockCreateV1Session.mockImplementation(() => {
      throw new Error('Unexpected V1 session');
    });
    mockCreateV2Session.mockImplementation(createTestSession);
  });

  it('uses a connecting guard without claiming an existing idle session is streaming', async () => {
    const { manager } = createManager();
    const activeSession = createdSessions[0];

    expect(manager.getState()).toMatchObject({ isConnecting: true, isStreaming: false });

    const unsubscribe = manager.subscribe(jest.fn());
    await Promise.resolve();

    expect(activeSession.connectToExistingSession).toHaveBeenCalledWith('session-old');
    expect(manager.getState()).toMatchObject({ isConnecting: true, isStreaming: false });

    activeSession.store.setState({ isConnecting: false, isStreaming: false });
    await flushNotifications();

    expect(manager.getState()).toMatchObject({ isConnecting: false, isStreaming: false });
    unsubscribe();
    manager.destroy();
  });

  it('ignores a queued notification owned by the destroyed session after handoff', async () => {
    const sendMessage = jest.fn(async () => ({ cloudAgentSessionId: 'session-new' }));
    const { manager } = createManager(sendMessage);
    const oldSession = createdSessions[0];

    manager.requestNewSession();
    await manager.sendMessage('continue building');

    const newSession = createdSessions[1];
    expect(oldSession.destroy).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({ isConnecting: true, isStreaming: false });

    newSession.store.setState({ isConnecting: false, isStreaming: true });
    await flushNotifications();
    expect(manager.getState().isStreaming).toBe(true);

    newSession.store.setState({ isStreaming: false });
    oldSession.capturedListeners[0]?.();

    expect(manager.getState().isStreaming).toBe(true);
    await flushNotifications();
    expect(manager.getState().isStreaming).toBe(false);
    manager.destroy();
  });

  it('propagates replacement mutation failure and clears the non-interruptible guard', async () => {
    const error = new Error('replacement failed');
    const { manager } = createManager(jest.fn(async () => Promise.reject(error)));

    manager.requestNewSession();

    await expect(manager.sendMessage('retryable prompt')).rejects.toBe(error);
    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: false,
      isConnecting: false,
      isStreaming: false,
    });
    manager.destroy();
  });

  it('reconnects the canonical session instead of a newer orphan row', async () => {
    const project = createProject();
    project.sessions = [
      { ...project.sessions[0]!, ended_at: '2026-08-31T00:00:00.000Z' },
      {
        ...project.sessions[0]!,
        id: 'orphan-row',
        cloud_agent_session_id: 'orphan-session',
      },
    ];
    const { manager } = createManager(jest.fn(), project);

    manager.subscribe(jest.fn());
    await Promise.resolve();

    expect(createdSessions[0]?.info.cloud_agent_session_id).toBe('orphan-session');
    expect(createdSessions[0]?.connectToExistingSession).not.toHaveBeenCalled();
    expect(createdSessions[1]?.info.cloud_agent_session_id).toBe('session-old');
    expect(createdSessions[1]?.connectToExistingSession).toHaveBeenCalledWith('session-old');
    manager.destroy();
  });

  it('requires a replacement when the canonical session is missing and preserves recovery on failure', async () => {
    const project = createProject();
    project.sessions = [
      {
        ...project.sessions[0]!,
        id: 'orphan-row',
        cloud_agent_session_id: 'orphan-session',
      },
    ];
    const error = new Error('replacement failed');
    const { manager } = createManager(
      jest.fn(async () => Promise.reject(error)),
      project
    );

    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: true,
      isConnecting: false,
    });
    manager.cancelNewSession();
    expect(manager.getState().pendingNewSession).toBe(true);

    await expect(manager.sendMessage('recover this project')).rejects.toBe(error);
    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: true,
      isConnecting: false,
    });
    manager.destroy();
  });

  it('does not apply replacement completion after the manager is destroyed', async () => {
    let resolveMutation: ((result: { cloudAgentSessionId: string }) => void) | undefined;
    const mutation = new Promise<{ cloudAgentSessionId: string }>(resolve => {
      resolveMutation = resolve;
    });
    const { manager } = createManager(jest.fn(() => mutation));

    manager.requestNewSession();
    const submission = manager.sendMessage('late prompt');
    manager.destroy();
    resolveMutation?.({ cloudAgentSessionId: 'session-late' });
    await submission;

    expect(createdSessions).toHaveLength(1);
  });
});
