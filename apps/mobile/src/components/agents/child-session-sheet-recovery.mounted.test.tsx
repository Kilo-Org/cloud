/* eslint-disable max-lines -- one mounted harness pins first-page, older-page, and runtime-error recovery together. */
import { createElement, Fragment } from 'react';
import { act } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProps,
  createRecoverySource,
  historyPage,
  host,
  makeAssistantMessage,
  modal,
  readyState,
  renderSheet,
  retryButton,
  type SheetProps,
  textValues,
  updateSheet,
  viewport,
} from './child-session-sheet-test-helpers';
import {
  type KiloSessionId,
  type SessionManagerConfig,
  type SessionSnapshotPageOutcome,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { type FlashListProps } from '@shopify/flash-list';
import { type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { QueryError } from '@/components/query-error';
import { performCopy } from '@/components/agents/use-message-copy';
import { i18n } from '@/i18n';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/agents/use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
  performCopy: vi.fn(),
}));

async function mountRecovery(messages = [makeAssistantMessage()]) {
  const fetchPage = vi
    .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    .mockRejectedValue(new Error('Connection failed. Please retry in a moment.'));
  const { manager, store, storage } = await createRecoverySource(fetchPage);
  function receive(message: StoredMessage) {
    storage.upsertMessage(message.info);
    for (const part of message.parts) {
      storage.upsertPart(message.info.id, part);
    }
  }
  const childId = 'child-1' as KiloSessionId;
  // Hydrate before rows land: with rows already in storage the manager treats
  // the stream as the truth and keeps the load in-flight instead of storing
  // the failure.
  let pending = manager.hydrateChildSession(childId);
  await pending;
  for (const message of messages) {
    receive(message);
  }
  const props = {
    ...buildProps({
      getChildMessages: store.get(manager.atoms.childMessages),
      hydrationState: store.get(manager.atoms.childSessionHydrationState)(childId),
    }),
    onRetry: () => {
      pending = manager.hydrateChildSession(props.sessionId as KiloSessionId);
    },
    onLoadOlderMessages: () => {
      pending = manager.loadOlderChildMessages(props.sessionId as KiloSessionId);
    },
    onClose: () => {
      props.visible = false;
    },
    onDismiss: () => {
      renderer.update(createElement(Fragment));
    },
  };
  const renderer = await renderSheet(props);
  async function sync(next: Partial<SheetProps> = {}) {
    Object.assign(props, next);
    props.getChildMessages = store.get(manager.atoms.childMessages);
    const state = store.get(manager.atoms.childSessionHydrationState)(props.sessionId);
    props.hydrationState = state;
    props.hasOlderMessages = state.status === 'ready' && state.hasOlder;
    props.isLoadingOlderMessages = state.status === 'ready' && state.isLoadingOlder;
    props.olderMessagesError = state.status === 'ready' ? state.olderError : null;
    await updateSheet(renderer, props);
  }
  async function retry(count = 1) {
    const press = retryButton(renderer.root).props.onPress as () => void;
    await act(async () => {
      for (let index = 0; index < count; index += 1) {
        press();
      }
      await Promise.resolve();
    });
    await sync();
  }
  async function settle() {
    await pending;
    await sync();
  }
  async function wait() {
    await pending;
  }
  return { renderer, manager, fetchPage, receive, sync, retry, settle, wait };
}

describe('ChildSessionSheet recovery', () => {
  it('keeps Retry through pending duplicates, drops the banner once streamed rows land, and recovers on a deduplicated reopen', async () => {
    // Storage starts empty so the settled failures keep owning the outcome:
    // with rows already in storage the manager drops the error instead.
    const sheet = await mountRecovery([]);
    const { renderer, fetchPage, manager } = sheet;
    const failure = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    fetchPage.mockReturnValueOnce(failure.promise);
    // Both presses arrive before React commits the disabled state.
    await sheet.retry(2);

    // A live child row lands while the retry is in flight: the banner and the
    // busy Retry persist — the in-flight request still owns the outcome.
    sheet.receive(makeAssistantMessage('m2', 'Live arrival'));
    await sheet.sync();
    const list = host(renderer.root, 'FlashList');
    const button = retryButton(renderer.root);
    const listProps = list.props as FlashListProps<StoredMessage>;
    const scrollEvent = {
      nativeEvent: {
        contentOffset: { y: 320 },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 400 },
      },
    };
    await act(async () => {
      const event = scrollEvent as NativeSyntheticEvent<NativeScrollEvent>;
      listProps.onScrollBeginDrag?.(event);
      viewport.offset = 320;
      listProps.onScrollEndDrag?.(event);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(textValues(list)).toEqual(['Live arrival']);
    expect(viewport.offset).toBe(320);

    failure.reject(new Error('fetch failed'));
    await sheet.settle();
    // The landed rows are the truth: the settled failure must not resurface as
    // "could not load" — the banner and Retry go away instead.
    expect(textValues(renderer.root)).not.toContain('Connection lost. Please retry in a moment.');
    expect(textValues(renderer.root)).not.toContain('Connection failed. Please retry in a moment.');
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(textValues(list)).toEqual(['Live arrival']);
    expect(host(renderer.root, 'FlashList')).toBe(list);
    expect(viewport.offset).toBe(320);

    // Reopening the sheet re-issues the load; overlapping opens dedupe to one
    // request and the recovered page lands above the live row.
    const success = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    fetchPage.mockReturnValueOnce(success.promise);
    const reopen = manager.hydrateChildSession('child-1' as KiloSessionId);
    const duplicate = manager.hydrateChildSession('child-1' as KiloSessionId);
    success.resolve(
      historyPage([
        makeAssistantMessage('m0', 'Older history'),
        makeAssistantMessage('m1', 'Complete child text'),
      ])
    );
    await reopen;
    await duplicate;
    await sheet.settle();
    expect(textValues(list)).toEqual(['Older history', 'Complete child text', 'Live arrival']);
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(host(renderer.root, 'FlashList')).toBe(list);
    expect(viewport.offset).toBe(320);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('allows dismissal during Retry without reopening on a late success', async () => {
    const sheet = await mountRecovery();
    const { renderer } = sheet;
    const pending = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    sheet.fetchPage.mockReturnValueOnce(pending.promise);
    await sheet.retry();
    const list = host(renderer.root, 'FlashList');
    await act(async () => {
      (host(renderer.root, 'SheetHeader').props.onDone as () => void)();
      await Promise.resolve();
    });
    await sheet.sync();
    expect(modal(renderer.root).props.visible).toBe(false);
    expect(host(renderer.root, 'FlashList')).toBe(list);
    expect(textValues(list)).toEqual(['child text']);
    await act(async () => {
      (modal(renderer.root).props.onDismiss as () => void)();
      await Promise.resolve();
    });
    pending.resolve(historyPage([makeAssistantMessage('m0', 'Recovered while closed')]));
    await sheet.wait();
    expect(renderer.toJSON()).toBeNull();
    await sheet.sync({ visible: true });
    expect(textValues(host(renderer.root, 'FlashList'))).toEqual([
      'Recovered while closed',
      'child text',
    ]);
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
  });

  it('does not carry the previous child error into a selected child with pending history', async () => {
    const sheet = await mountRecovery();
    const first = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    sheet.fetchPage.mockReturnValueOnce(first.promise);
    await sheet.retry();
    sheet.receive(makeAssistantMessage('m3', 'Selected child text', 'child-2'));
    const second = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    sheet.fetchPage.mockReturnValueOnce(second.promise);
    const secondHydration = sheet.manager.hydrateChildSession('child-2' as KiloSessionId);
    await sheet.sync({ sessionId: 'child-2', title: 'Selected child' });
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
    first.reject(new Error('Previous child failed again'));
    await sheet.settle();
    expect(textValues(host(sheet.renderer.root, 'FlashList'))).toEqual(['Selected child text']);
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(host(sheet.renderer.root, 'SheetHeader').props.title).toBe('Selected child');
    second.resolve(historyPage([], null, 'child-2'));
    await secondHydration;
    await sheet.sync();
    expect(textValues(host(sheet.renderer.root, 'FlashList'))).toEqual(['Selected child text']);
  });

  it('recovers first-page and older-page errors independently without clearing the runtime error', async () => {
    const sheet = await mountRecovery();
    const { renderer } = sheet;
    const list = host(renderer.root, 'FlashList');
    await sheet.sync({ sessionError: 'Runtime failure' });
    expect(textValues(renderer.root)).toEqual(
      expect.arrayContaining([
        i18n.t('agentChat.session.connectionTrouble'),
        i18n.t('agentChat.messageFailure.assistantFailed'),
      ])
    );
    sheet.fetchPage.mockResolvedValueOnce(historyPage([], 'older-cursor'));
    await sheet.retry();
    await sheet.settle();
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
    await sheet.manager.loadOlderChildMessages('child-1' as KiloSessionId);
    await sheet.sync();
    expect(textValues(renderer.root)).toContain(i18n.t('agentChat.olderMessages.couldNotLoad'));
    const older = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    sheet.fetchPage.mockReturnValueOnce(older.promise);
    await sheet.retry();
    expect(textValues(renderer.root)).toContain(i18n.t('agentChat.messageFailure.assistantFailed'));
    expect(textValues(renderer.root)).toContain(i18n.t('agentChat.olderMessages.couldNotLoad'));
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
    older.resolve(historyPage([makeAssistantMessage('m0', 'Older recovered row')]));
    await sheet.settle();
    expect(textValues(list)).toEqual(['Older recovered row', 'child text']);
    expect(textValues(renderer.root)).toContain(i18n.t('agentChat.messageFailure.assistantFailed'));
    expect(textValues(renderer.root)).not.toContain('Retry');
    expect(host(renderer.root, 'FlashList')).toBe(list);
  });

  it.each([
    ['invalid_data', 'agentChat.olderMessages.unavailable'],
    ['too_large', 'agentChat.olderMessages.tooLarge'],
  ] as const)('keeps %s older-page errors non-retryable beside cached rows', async (kind, key) => {
    const sheet = await mountRecovery();
    sheet.fetchPage.mockResolvedValueOnce(historyPage([], 'older-cursor'));
    await sheet.retry();
    await sheet.settle();
    sheet.fetchPage.mockResolvedValueOnce({ kind });
    await sheet.manager.loadOlderChildMessages('child-1' as KiloSessionId);
    await sheet.sync();
    expect(textValues(sheet.renderer.root)).toContain(i18n.t(key));
    expect(textValues(sheet.renderer.root)).toContain('child text');
    expect(textValues(sheet.renderer.root)).not.toContain('Retry');
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
  });

  it('preserves uncached Retry, loading, confirmed empty history, and later live content', async () => {
    const sheet = await mountRecovery([]);
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.session.connectionTrouble')
    );
    expect(retryButton(sheet.renderer.root).props.disabled).toBe(false);
    const pending = Promise.withResolvers<SessionSnapshotPageOutcome | null>();
    sheet.fetchPage.mockReturnValueOnce(pending.promise);
    await sheet.retry();
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.loading')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
    pending.resolve(historyPage());
    await sheet.settle();
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.noMessages')
    );
    sheet.receive(makeAssistantMessage('m1', 'First live row'));
    await sheet.sync();
    expect(textValues(host(sheet.renderer.root, 'FlashList'))).toEqual(['First live row']);
    expect(textValues(sheet.renderer.root)).not.toContain(
      i18n.t('agentChat.childSessionSheet.noMessages')
    );
  });

  it('does not give an uncached runtime error a hydration Retry', async () => {
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      sessionError: 'Runtime failure',
    });
    // The sheet's own failure screen (child-session-sheet.tsx) is not the
    // transcript status slot, so it resolves the runtime failure through
    // `describeSessionRuntimeFailure`: an unrecognized failure is the
    // assistant-failure line, never the page-load fallback.
    expect(textValues(renderer.root)).toContain(i18n.t('agentChat.messageFailure.assistantFailed'));
    expect(textValues(renderer.root)).not.toContain(
      i18n.t('agentChat.session.failedToLoadDetails')
    );
    expect(textValues(renderer.root)).not.toContain('Retry');
  });

  it('copies the untranslated runtime failure from the full-screen child error', async () => {
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      sessionError: 'Runtime failure',
    });
    const copy = renderer.root.find(
      node =>
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === i18n.t('agentChat.session.copyErrorDetails')
    );
    await act(async () => {
      (copy.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(performCopy).toHaveBeenCalledWith(
      'child-1\nSubagent session failed\nThe response failed.\nRuntime failure'
    );
  });
});
