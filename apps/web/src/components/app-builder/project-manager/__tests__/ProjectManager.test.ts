import type { ProjectWithMessages, SessionDisplayInfo } from '@/lib/app-builder/types';
import type { AppBuilderSession } from '../types';

const mockStartPreviewPolling = jest.fn((_config?: unknown) => ({
  isPolling: true,
  stop: jest.fn(),
}));
const mockSessions = new Map<string, AppBuilderSession>();

function makeSession(info: SessionDisplayInfo): AppBuilderSession {
  const session = {
    type: 'v2' as const,
    info,
    getState: jest.fn(() => ({
      messages: [],
      isStreaming: false,
      questionRequestIds: new Map(),
      childSessionMessages: new Map(),
    })),
    subscribe: jest.fn(() => () => {}),
    getChildSessionMessages: jest.fn(() => []),
    sendMessage: jest.fn(async () => {}),
    interrupt: jest.fn(async () => {}),
    startInitialStreaming: jest.fn(),
    connectToExistingSession: jest.fn(),
    loadMessages: jest.fn(),
    destroy: jest.fn(),
  } satisfies AppBuilderSession;
  mockSessions.set(info.cloud_agent_session_id ?? info.id, session);
  return session;
}

jest.mock('../preview-polling', () => ({
  startPreviewPolling: (config: unknown) => mockStartPreviewPolling(config),
}));
jest.mock('../deployments', () => ({ deploy: jest.fn() }));
jest.mock('../sessions/v2/v2-session', () => ({
  createV2Session: (config: { info: SessionDisplayInfo }) => makeSession(config.info),
}));
jest.mock('../sessions/v1/v1-session', () => ({
  createV1Session: (config: { info: SessionDisplayInfo }) => makeSession(config.info),
}));

import { createProjectManager } from '../../ProjectManager';

function makeProject(
  sessions: ProjectWithMessages['sessions'],
  sessionId: string | null = 'canonical-session'
): ProjectWithMessages {
  return {
    id: 'project-1',
    session_id: sessionId,
    deployment_id: null,
    model_id: 'test-model',
    git_repo_full_name: null,
    messages: [],
    sessions,
  } as unknown as ProjectWithMessages;
}

function makeSessionInfo(
  id: string,
  overrides: Partial<ProjectWithMessages['sessions'][number]> = {}
): ProjectWithMessages['sessions'][number] {
  return {
    id,
    cloud_agent_session_id: id,
    worker_version: 'v2',
    ended_at: null,
    title: null,
    initiated: true,
    prepared: true,
    ...overrides,
  };
}

function makeTrpcClient() {
  return {
    appBuilder: {
      sendMessage: {
        mutate: jest.fn(async () => ({
          cloudAgentSessionId: 'replacement-session',
          workerVersion: 'v2' as const,
        })),
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createProjectManager session recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessions.clear();
  });

  it('reconnects the canonical session instead of a newer orphan row', async () => {
    const trpcClient = makeTrpcClient();
    const manager = createProjectManager({
      project: makeProject([
        makeSessionInfo('canonical-session', { ended_at: '2026-08-31T00:00:00.000Z' }),
        makeSessionInfo('orphan-session'),
      ]),
      trpcClient: trpcClient as never,
      organizationId: null,
    });

    manager.subscribe(() => {});
    await flushMicrotasks();

    expect(mockSessions.get('canonical-session')?.connectToExistingSession).toHaveBeenCalledWith(
      'canonical-session'
    );
    expect(mockSessions.get('orphan-session')?.connectToExistingSession).not.toHaveBeenCalled();
    expect(manager.getState().sessions.at(-1)?.info.cloud_agent_session_id).toBe(
      'canonical-session'
    );
    manager.destroy();
  });

  it.each([
    ['unprepared', [makeSessionInfo('canonical-session', { initiated: null, prepared: false })]],
    ['orphaned', [makeSessionInfo('orphan-session')]],
  ])('recovers an %s canonical session through forceNewSession', async (_label, sessions) => {
    const trpcClient = makeTrpcClient();
    const manager = createProjectManager({
      project: makeProject(sessions),
      trpcClient: trpcClient as never,
      organizationId: null,
    });

    expect(manager.getState().pendingNewSession).toBe(true);
    expect(manager.getState().isRecoveringSession).toBe(true);
    expect(mockStartPreviewPolling).toHaveBeenCalled();

    manager.subscribe(() => {});
    await flushMicrotasks();
    for (const session of mockSessions.values()) {
      expect(session.connectToExistingSession).not.toHaveBeenCalled();
      expect(session.startInitialStreaming).not.toHaveBeenCalled();
    }

    manager.sendMessage('Recover this project');
    await flushMicrotasks();

    expect(trpcClient.appBuilder.sendMessage.mutate).toHaveBeenCalledWith({
      projectId: 'project-1',
      message: 'Recover this project',
      images: undefined,
      model: 'test-model',
      forceNewSession: true,
    });
    expect(mockSessions.get('replacement-session')?.connectToExistingSession).toHaveBeenCalledWith(
      'replacement-session'
    );
    manager.destroy();
  });

  it('starts a prepared, uninitiated canonical session', async () => {
    const manager = createProjectManager({
      project: makeProject([
        makeSessionInfo('canonical-session', { initiated: false, prepared: true }),
      ]),
      trpcClient: makeTrpcClient() as never,
      organizationId: null,
    });

    manager.subscribe(() => {});
    await flushMicrotasks();

    expect(mockSessions.get('canonical-session')?.startInitialStreaming).toHaveBeenCalled();
    expect(mockSessions.get('canonical-session')?.connectToExistingSession).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('fails open and reconnects when canonical session state is unknown', async () => {
    const manager = createProjectManager({
      project: makeProject([
        makeSessionInfo('canonical-session', { initiated: null, prepared: null }),
      ]),
      trpcClient: makeTrpcClient() as never,
      organizationId: null,
    });

    manager.subscribe(() => {});
    await flushMicrotasks();

    expect(mockSessions.get('canonical-session')?.connectToExistingSession).toHaveBeenCalledWith(
      'canonical-session'
    );
    expect(manager.getState().pendingNewSession).toBe(false);
    manager.destroy();
  });

  it('keeps stale-session recovery retryable when replacement creation fails', async () => {
    const trpcClient = makeTrpcClient();
    trpcClient.appBuilder.sendMessage.mutate.mockRejectedValueOnce(new Error('Unavailable'));
    const manager = createProjectManager({
      project: makeProject([
        makeSessionInfo('canonical-session', { initiated: null, prepared: false }),
      ]),
      trpcClient: trpcClient as never,
      organizationId: null,
    });

    manager.sendMessage('Recover this project');
    await flushMicrotasks();

    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: true,
      isStreaming: false,
    });
    manager.destroy();
  });

  it('does not allow mandatory stale-session recovery to be cancelled', () => {
    const manager = createProjectManager({
      project: makeProject([
        makeSessionInfo('canonical-session', { initiated: null, prepared: false }),
      ]),
      trpcClient: makeTrpcClient() as never,
      organizationId: null,
    });

    manager.cancelNewSession();

    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: true,
    });
    manager.destroy();
  });

  it('keeps an ordinary new chat cancellable when session creation fails', async () => {
    const trpcClient = makeTrpcClient();
    trpcClient.appBuilder.sendMessage.mutate.mockRejectedValueOnce(new Error('Unavailable'));
    const manager = createProjectManager({
      project: makeProject([makeSessionInfo('canonical-session')]),
      trpcClient: trpcClient as never,
      organizationId: null,
    });

    manager.requestNewSession();
    manager.sendMessage('Start another chat');
    await flushMicrotasks();

    expect(manager.getState()).toMatchObject({
      pendingNewSession: true,
      isRecoveringSession: false,
      isStreaming: false,
    });

    manager.cancelNewSession();
    expect(manager.getState().pendingNewSession).toBe(false);
    manager.destroy();
  });
});
