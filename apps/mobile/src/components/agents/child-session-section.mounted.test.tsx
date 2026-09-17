/* eslint-disable max-lines -- mounted suite pins the subagent card's translation gate and its live-status derivation through the real SDK store */
import { createElement } from 'react';
import { createStore } from 'jotai';
import {
  createSessionManager,
  createUserWebConnection,
  type KiloSessionId,
  type SessionManager,
  type SessionManagerConfig,
  type SessionSnapshotPageOutcome,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import {
  createJotaiStorage,
  type JotaiSessionStorage,
} from '@kilocode/cloud-agent-sdk/storage/jotai';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { setConfig } from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

import { ChildSessionSection } from './child-session-section';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  I18nManager: { isRTL: false },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({ Bot: 'Bot', Loader2: 'Loader2' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#999999',
    agentSky: '#5B9BD5',
    info: '#2D7DD2',
    good: '#3FA34D',
    destructive: '#BE4E3F',
  }),
}));
vi.mock('./child-session-model-label', () => ({
  ChildSessionModelLabel: 'ChildSessionModelLabel',
}));
// Observe the manager's real storage without replacing its replay or deduplication.
vi.mock('@kilocode/cloud-agent-sdk/storage/jotai', { spy: true });

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function makeTaskPart(input: Record<string, unknown>): ToolPart {
  return {
    id: 'task-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'task',
    callID: 'call-1',
    state: { status: 'pending', input, raw: '' },
  };
}

async function mountSection(
  input: Record<string, unknown>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ChildSessionSection, {
        part: makeTaskPart(input),
        childMessages: [],
        onOpenChildSession: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** Flush the dynamic client import and the queued request. */
async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the dynamic import and request
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    }
  });
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function textValues(root: TestRenderer.ReactTestInstance): unknown[] {
  return findByType(root, 'Text').map(node => node.props.children);
}

describe('ChildSessionSection tool-summary translation gate', () => {
  beforeEach(() => {
    requestMock.mockReset();
    setConfig({ enabled: false, model: MODEL });
  });

  it('never requests a translation for the already-localized fallback task label', async () => {
    requestMock.mockResolvedValue('Tâche');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({});
    await settleTranslation();

    expect(requestMock).not.toHaveBeenCalled();
    expect(textValues(renderer.root)).toContain('Task');
    expect(textValues(renderer.root)).not.toContain('Tâche');
    act(() => {
      renderer.unmount();
    });
  });

  it('requests a translation for a description-derived task name', async () => {
    requestMock.mockResolvedValue('Tâche enfant');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({ description: 'child task' });
    await settleTranslation();

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'child task', model: MODEL.id })
    );
    expect(textValues(renderer.root)).toContain('Tâche enfant');
    act(() => {
      renderer.unmount();
    });
  });

  it('requests a translation for a prompt-derived task name', async () => {
    requestMock.mockResolvedValue('Faire la chose');
    setConfig({ enabled: true, model: MODEL });

    const renderer = await mountSection({ prompt: 'do the thing' });
    await settleTranslation();

    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'do the thing' }));
    act(() => {
      renderer.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// Live task status through the real SDK store
// ---------------------------------------------------------------------------
//
// The card's badge and spinner read `part.state.status` straight from the SDK
// store, so these scenarios feed the real memory/jotai storage the same
// `message.part.updated` shapes the `child-sessions` fixture uses and render
// the section with the stored part. The lifecycle guard that makes a stale
// terminal replay lose lives in the store (`storage/helpers.ts`); these tests
// pin the mobile-visible outcome so a regression cannot re-land silently.

const ROOT_SESSION = 'ses-root' as KiloSessionId;
const CHILD_SESSION = 'ses-child' as KiloSessionId;
const ROOT_MESSAGE_ID = 'msg-root';
const TASK_PART_ID = 'prt-task';
const LIVE_RUNNING_AT = 1000;
const STALE_SETTLED_AT = 900;
const FRESH_SETTLED_AT = 1100;

type TaskStatus = 'pending' | 'running' | 'completed' | 'error';

const managers: SessionManager[] = [];
const mountedCards: TestRenderer.ReactTestRenderer[] = [];

function rootAssistantMessage(): StoredMessage {
  return {
    info: {
      id: ROOT_MESSAGE_ID,
      sessionID: ROOT_SESSION,
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-user',
      modelID: 'claude',
      providerID: 'anthropic',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
}

/** The task input the `real-session-excerpt` event stream carried. */
function taskInput(): Record<string, unknown> {
  return {
    description: 'Read memory bank files',
    prompt: 'Read ALL files in the .kilocode/rules/memory-bank/ directory',
    subagent_type: 'explore',
  };
}

function taskPart(status: TaskStatus, settledAt?: number): ToolPart {
  const base = {
    id: TASK_PART_ID,
    sessionID: ROOT_SESSION,
    messageID: ROOT_MESSAGE_ID,
    type: 'tool' as const,
    tool: 'task',
    callID: 'call-task',
  };
  if (status === 'pending') {
    return { ...base, state: { status: 'pending', input: taskInput(), raw: '' } };
  }
  if (status === 'running') {
    return {
      ...base,
      state: {
        status: 'running',
        input: taskInput(),
        title: 'Read memory bank files',
        metadata: { sessionId: CHILD_SESSION },
        time: { start: 1 },
      },
    };
  }
  if (status === 'completed') {
    return {
      ...base,
      state: {
        status: 'completed',
        input: taskInput(),
        output: 'done',
        title: 'Read memory bank files',
        metadata: { sessionId: CHILD_SESSION },
        time: { start: 1, end: settledAt ?? 2 },
      },
    };
  }
  return {
    ...base,
    state: {
      status: 'error',
      input: taskInput(),
      error: 'Subagent failed',
      metadata: { sessionId: CHILD_SESSION },
      time: { start: 1, end: settledAt ?? 2 },
    },
  };
}

/** Apply a part exactly as the live/store path does: message info then part. */
function feedTaskPart(storage: JotaiSessionStorage, part: ToolPart, eventTime?: number): void {
  storage.upsertMessage(rootAssistantMessage().info);
  storage.upsertPart(part.messageID, part, eventTime);
}

function storedTaskPart(storage: JotaiSessionStorage): ToolPart {
  const part = storage.getParts(ROOT_MESSAGE_ID).find(candidate => candidate.id === TASK_PART_ID);
  if (part?.type !== 'tool') {
    throw new Error('stored task part missing');
  }
  return part;
}

function childPage(part: ToolPart): SessionSnapshotPageOutcome {
  return {
    kind: 'success',
    info: { id: CHILD_SESSION },
    messages: [{ info: rootAssistantMessage().info, parts: [part] }],
    nextCursor: null,
    omittedItemCount: 0,
  };
}

async function renderCard(part: ToolPart): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ChildSessionSection, {
        part,
        childMessages: [],
        onOpenChildSession: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedCards.push(renderer);
  return renderer;
}

/** The status badge is the only Text carrying a bare status text class. */
function statusBadge(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const badge = findByType(root, 'Text').find(node => {
    const className = node.props.className;
    return (
      typeof className === 'string' && /^text-xs text-(info|good|destructive)$/.test(className)
    );
  });
  if (!badge) {
    throw new Error('status badge was not rendered');
  }
  return badge;
}

/**
 * A real session manager over its real jotai storage, created the way
 * `switchSession` creates it. `fetchSnapshotPage` is the seam the child-page
 * reopen replay uses (`replayChildMessages`).
 */
async function createTaskManager(
  fetchChildPage: NonNullable<SessionManagerConfig['fetchSnapshotPage']>
): Promise<{ manager: SessionManager; storage: JotaiSessionStorage }> {
  const store = createStore();
  const userWebConnection = createUserWebConnection({ websocketUrl: '', getAuthToken: () => '' });
  vi.spyOn(userWebConnection, 'subscribeToCliSession').mockReturnValue(vi.fn<() => void>());
  vi.spyOn(userWebConnection, 'onSystemEvent').mockReturnValue(vi.fn<() => void>());
  const api = {};
  // The root's read-only transport reads its own (empty) first page on
  // connect; only the child reopen replay should reach the scenario's page.
  async function fetchPageFor(
    id: KiloSessionId,
    options: { cursor?: string }
  ): Promise<SessionSnapshotPageOutcome | null> {
    if (id === CHILD_SESSION) {
      const page = await fetchChildPage(id, options);
      return page;
    }
    return { kind: 'success', info: { id }, messages: [], nextCursor: null, omittedItemCount: 0 };
  }
  const manager = createSessionManager({
    store,
    resolveSession: vi.fn<SessionManagerConfig['resolveSession']>().mockResolvedValue({
      type: 'read-only',
      kiloSessionId: ROOT_SESSION,
    }),
    fetchSession: vi.fn<SessionManagerConfig['fetchSession']>().mockResolvedValue({
      kiloSessionId: ROOT_SESSION,
      cloudAgentSessionId: null,
      title: 'Root',
      organizationId: null,
      gitUrl: null,
      gitBranch: null,
      mode: null,
      model: null,
      variant: null,
      repository: null,
      isInitiated: true,
      needsLegacyPrepare: false,
      isPreparingAsync: false,
      prompt: null,
      initialMessageId: null,
      associatedPr: null,
    }),
    fetchSnapshot: vi.fn<SessionManagerConfig['fetchSnapshot']>(),
    fetchSnapshotPage: fetchPageFor,
    getTicket: vi.fn<SessionManagerConfig['getTicket']>(),
    prepare: vi.fn<SessionManagerConfig['prepare']>(),
    initiate: vi.fn<SessionManagerConfig['initiate']>(),
    userWebConnection,
    api: api as SessionManagerConfig['api'],
  });
  managers.push(manager);
  await manager.switchSession(ROOT_SESSION);
  const created = vi.mocked(createJotaiStorage).mock.results.at(-1);
  if (created?.type !== 'return') {
    throw new Error('manager storage was not created');
  }
  return { manager, storage: created.value };
}

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    for (const renderer of mountedCards.splice(0)) {
      renderer.unmount();
    }
    for (const manager of managers.splice(0)) {
      manager.destroy();
    }
  });
});

describe('ChildSessionSection live task status', () => {
  it('shows a pending task as pending and a running task as running, never completed', async () => {
    const { storage } = await createTaskManager(
      vi.fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    );

    feedTaskPart(storage, taskPart('pending'), 100);
    const pendingRenderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(pendingRenderer.root).props.children).toBe('pending');
    expect(findByType(pendingRenderer.root, 'SpinningIcon')).toHaveLength(1);
    expect(textValues(pendingRenderer.root)).not.toContain('completed');

    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);
    expect(storedTaskPart(storage).state.status).toBe('running');
    const runningRenderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(runningRenderer.root).props.children).toBe('running');
    expect(statusBadge(runningRenderer.root).props.className).toContain('text-info');
    expect(findByType(runningRenderer.root, 'SpinningIcon')).toHaveLength(1);
    expect(textValues(runningRenderer.root)).toContain(i18n.t('agentChat.partDetail.thinking'));
    expect(textValues(runningRenderer.root)).not.toContain('completed');
  });

  it('cannot be flipped to completed by a stale or unordered terminal replay', async () => {
    const { storage } = await createTaskManager(
      vi.fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    );

    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);

    // A snapshot/replay re-delivery of an older terminal: its settle time
    // predates the live running update, so the store drops it.
    feedTaskPart(storage, taskPart('completed', STALE_SETTLED_AT), STALE_SETTLED_AT);
    expect(storedTaskPart(storage).state.status).toBe('running');

    // A terminal with no ordering evidence at all must not replace live state.
    feedTaskPart(storage, taskPart('completed', STALE_SETTLED_AT));
    expect(storedTaskPart(storage).state.status).toBe('running');

    const renderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(renderer.root).props.children).toBe('running');
    expect(findByType(renderer.root, 'SpinningIcon')).toHaveLength(1);
    expect(textValues(renderer.root)).not.toContain('completed');

    // The guard must not swallow a terminal that really does postdate the run.
    feedTaskPart(storage, taskPart('completed', FRESH_SETTLED_AT), FRESH_SETTLED_AT);
    expect(storedTaskPart(storage).state.status).toBe('completed');
    const settledRenderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(settledRenderer.root).props.children).toBe('completed');
    expect(findByType(settledRenderer.root, 'SpinningIcon')).toHaveLength(0);
  });

  it('renders a terminal error as the destructive error badge, never completed', async () => {
    const { storage } = await createTaskManager(
      vi.fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    );

    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);
    feedTaskPart(storage, taskPart('error', FRESH_SETTLED_AT), FRESH_SETTLED_AT);

    expect(storedTaskPart(storage).state.status).toBe('error');
    const renderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(renderer.root).props.children).toBe('error');
    expect(statusBadge(renderer.root).props.className).toContain('text-destructive');
    expect(findByType(renderer.root, 'AnimatedView')[0]?.props.style).toEqual({
      borderStartWidth: 2,
      borderStartColor: '#BE4E3F',
    });
    expect(findByType(renderer.root, 'SpinningIcon')).toHaveLength(0);
    expect(textValues(renderer.root)).not.toContain('completed');
  });

  it('keeps a running task live when no terminal event ever arrives', async () => {
    const { storage } = await createTaskManager(
      vi.fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    );

    feedTaskPart(storage, taskPart('pending'), 100);
    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);

    // No terminal event: the card has no local completion inference to fall
    // back on, and there is no card-without-part state to show instead.
    const renderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(renderer.root).props.children).toBe('running');
    expect(findByType(renderer.root, 'SpinningIcon')).toHaveLength(1);
    expect(textValues(renderer.root)).not.toContain('completed');
  });

  it('survives a page replay while running and then a re-applied stale terminal', async () => {
    const fetchChildPage = vi
      .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
      .mockResolvedValueOnce(childPage(taskPart('running')));
    const { manager, storage } = await createTaskManager(fetchChildPage);

    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);

    // Reopen: the manager replays a page through `replayChildMessages`. The
    // page re-delivers the running part with no event time of its own, so the
    // live ordering evidence has to survive it.
    await manager.hydrateChildSession(CHILD_SESSION);
    expect(fetchChildPage).toHaveBeenCalledTimes(1);
    expect(storedTaskPart(storage).state.status).toBe('running');

    // The stale terminal event arrives (again) after the replay.
    feedTaskPart(storage, taskPart('completed', STALE_SETTLED_AT), STALE_SETTLED_AT);
    expect(storedTaskPart(storage).state.status).toBe('running');

    const renderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(renderer.root).props.children).toBe('running');
    expect(findByType(renderer.root, 'SpinningIcon')).toHaveLength(1);
    expect(textValues(renderer.root)).not.toContain('completed');
  });

  it('drops a stale terminal carried by the replayed page itself', async () => {
    const fetchChildPage = vi
      .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
      .mockResolvedValueOnce(childPage(taskPart('completed', STALE_SETTLED_AT)));
    const { manager, storage } = await createTaskManager(fetchChildPage);

    feedTaskPart(storage, taskPart('running'), LIVE_RUNNING_AT);
    await manager.hydrateChildSession(CHILD_SESSION);

    expect(storedTaskPart(storage).state.status).toBe('running');
    const renderer = await renderCard(storedTaskPart(storage));
    expect(statusBadge(renderer.root).props.children).toBe('running');
    expect(textValues(renderer.root)).not.toContain('completed');
  });
});
