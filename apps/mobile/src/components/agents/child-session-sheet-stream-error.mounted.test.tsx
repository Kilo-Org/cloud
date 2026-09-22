import { act } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProps,
  createRecoverySource,
  historyPage,
  host,
  makeAssistantMessage,
  renderSheet,
  retryButton,
  type SheetProps,
  textValues,
  updateSheet,
} from './child-session-sheet-test-helpers';
import {
  type KiloSessionId,
  type SessionManagerConfig,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';
import { HELD_CHILD_LOAD_RETRY_MS } from './child-session-sheet';
import { i18n } from '@/i18n';
import { QueryError } from '@/components/query-error';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/agents/use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
  performCopy: vi.fn(),
}));

const CHILD_ID = 'child-1' as KiloSessionId;

/**
 * A child session whose first-page load always fails. Hydration runs before
 * any row lands — with rows already in storage the manager treats the stream
 * as the truth and keeps the load in-flight instead of storing the failure —
 * so the stored error is real and the sheet renders it (full-screen until a
 * row arrives, then the banner above live rows). Pass `[]` to keep storage
 * empty so the error renders full-screen.
 */
async function mountFailingChildLoad(
  messages: StoredMessage[] = [makeAssistantMessage()],
  fetchPage = vi
    .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    .mockRejectedValue(new Error('Connection lost. Please retry in a moment.'))
) {
  const { manager, store, storage } = await createRecoverySource(fetchPage);

  let pending = manager.hydrateChildSession(CHILD_ID);
  await pending;
  for (const message of messages) {
    storage.upsertMessage(message.info);
    for (const part of message.parts) {
      storage.upsertPart(message.info.id, part);
    }
  }

  const props = {
    ...buildProps({
      getChildMessages: store.get(manager.atoms.childMessages),
      hydrationState: store.get(manager.atoms.childSessionHydrationState)(CHILD_ID),
    }),
    onRetry: () => {
      pending = manager.hydrateChildSession(CHILD_ID);
    },
  };
  const renderer = await renderSheet(props);

  function receive(message: StoredMessage) {
    storage.upsertMessage(message.info);
    for (const part of message.parts) {
      storage.upsertPart(message.info.id, part);
    }
  }
  async function sync(next: Partial<SheetProps> = {}) {
    Object.assign(props, next);
    props.getChildMessages = store.get(manager.atoms.childMessages);
    props.hydrationState = store.get(manager.atoms.childSessionHydrationState)(CHILD_ID);
    await updateSheet(renderer, props);
  }
  async function retry() {
    const press = retryButton(renderer.root).props.onPress as () => void;
    await act(async () => {
      press();
      await Promise.resolve();
    });
    await sync();
  }
  async function settle() {
    await pending;
    await sync();
  }
  // Advance past the sheet's held-load retry cadence and let the re-issued
  // load settle, then re-render with the store's latest hydration state.
  async function advanceRetry() {
    await act(async () => {
      vi.advanceTimersByTime(HELD_CHILD_LOAD_RETRY_MS);
      await pending;
    });
    await sync();
  }

  return { renderer, fetchPage, receive, sync, retry, settle, advanceRetry };
}

describe('ChildSessionSheet streamed session load error', () => {
  it('hides the load error banner once the child session is streaming', async () => {
    const sheet = await mountFailingChildLoad();
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(1);

    // A live child row lands and the task turns streaming: the stale load
    // failure must not sit above the live transcript.
    sheet.receive(makeAssistantMessage('m2', 'Live arrival'));
    await sheet.sync({ isStreaming: true });

    expect(textValues(host(sheet.renderer.root, 'FlashList'))).toEqual([
      'child text',
      'Live arrival',
    ]);
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(textValues(sheet.renderer.root)).not.toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
  });

  it('keeps the load error banner and Retry when nothing streams', async () => {
    // Storage stays empty: with rows present the manager treats the stream as
    // the truth and drops the error instead, so the persisting banner across a
    // failed Retry needs a child that never streamed.
    const sheet = await mountFailingChildLoad([]);
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    // The transport's English detail is classified: the reader sees the
    // translated line, and a transient failure keeps its Retry.
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.session.connectionTrouble')
    );
    expect(textValues(sheet.renderer.root)).not.toContain(
      'Connection lost. Please retry in a moment.'
    );
    expect(retryButton(sheet.renderer.root).props.disabled).toBe(false);
    expect(sheet.fetchPage).toHaveBeenCalledTimes(1);

    await sheet.retry();
    await sheet.settle();

    expect(sheet.fetchPage).toHaveBeenCalledTimes(2);
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.session.connectionTrouble')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(1);
  });

  it('shows a gone child as not found with no Retry', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: { status: 'error', message: 'This session is no longer available.' },
      })
    );

    expect(textValues(renderer.root)).toContain(i18n.t('queryError.notFoundDescription'));
    expect(textValues(renderer.root)).not.toContain('This session is no longer available.');
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(1);
    expect(
      renderer.root.findAll(
        node => (node.type as string) === 'Pressable' && node.props.accessibilityLabel === 'Retry'
      )
    ).toHaveLength(0);
  });

  it('holds the loading state instead of the full-screen load error while streaming', async () => {
    const sheet = await mountFailingChildLoad([]);
    // No row has landed yet, so the failed first page renders full-screen.
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );

    // The child task turns streaming before its first row lands: the sheet
    // must hold the loading state, not the load error.
    await sheet.sync({ isStreaming: true });
    expect(textValues(sheet.renderer.root)).not.toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.loading')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);

    // When the stream stops without ever delivering a row, the load error is
    // the truth again and Retry returns.
    await sheet.sync({ isStreaming: false });
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(retryButton(sheet.renderer.root).props.disabled).toBe(false);
  });

  it('re-issues the held load while streaming and shows the rows when they land', async () => {
    const fetchPage = vi
      .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
      .mockRejectedValueOnce(new Error('Connection lost. Please retry in a moment.'))
      .mockResolvedValueOnce(historyPage([makeAssistantMessage('m2', 'Restored row')]));
    const sheet = await mountFailingChildLoad([], fetchPage);

    // The first page failed before any row landed and the child is streaming:
    // the sheet holds loading and shows no error.
    await sheet.sync({ isStreaming: true });
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.loading')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(sheet.fetchPage).toHaveBeenCalledTimes(1);

    // The held load re-issues on its cadence; this time the fetch recovers,
    // so the rows land and replace the loading state.
    await sheet.advanceRetry();

    expect(sheet.fetchPage).toHaveBeenCalledTimes(2);
    expect(textValues(host(sheet.renderer.root, 'FlashList'))).toEqual(['Restored row']);
    expect(textValues(sheet.renderer.root)).not.toContain(
      i18n.t('agentChat.childSessionSheet.loading')
    );
  });
});
