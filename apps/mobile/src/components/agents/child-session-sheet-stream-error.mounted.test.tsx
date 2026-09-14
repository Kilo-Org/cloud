/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the native tree without a DOM. */
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProps,
  createRecoverySource,
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
import { i18n } from '@/i18n';
import { QueryError } from '@/components/query-error';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

const CHILD_ID = 'child-1' as KiloSessionId;

/**
 * A child session whose first-page load always fails, with one cached row so
 * the sheet renders its content branch (the banner above live rows) rather than
 * the full-screen error.
 */
async function mountFailingChildLoad() {
  const fetchPage = vi
    .fn<NonNullable<SessionManagerConfig['fetchSnapshotPage']>>()
    .mockRejectedValue(new Error('Service is unavailable right now. Please try again.'));
  const { manager, store, storage } = await createRecoverySource(fetchPage);
  const seed = makeAssistantMessage();
  storage.upsertMessage(seed.info);
  for (const part of seed.parts) {
    storage.upsertPart(seed.info.id, part);
  }

  let pending = manager.hydrateChildSession(CHILD_ID);
  await pending;
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

  return { renderer, fetchPage, receive, sync, retry, settle };
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
    const sheet = await mountFailingChildLoad();
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(sheet.fetchPage).toHaveBeenCalledTimes(1);

    await sheet.retry();
    await sheet.settle();

    expect(sheet.fetchPage).toHaveBeenCalledTimes(2);
    expect(textValues(sheet.renderer.root)).toContain(
      i18n.t('agentChat.childSessionSheet.couldNotLoad')
    );
    expect(sheet.renderer.root.findAllByType(QueryError)).toHaveLength(1);
  });
});
