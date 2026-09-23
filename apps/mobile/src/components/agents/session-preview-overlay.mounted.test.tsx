import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import {
  BASE_TARGET,
  mountOverlay,
  openPreview,
  pressByLabel,
  previewState,
  resetPreviewHolder,
  resetPreviewStore,
  targetWith,
  textWith,
} from './session-preview-overlay.test-helpers';
import { getSessionPreviewSnapshot } from './session-preview-state';

beforeEach(resetPreviewHolder);
afterEach(resetPreviewStore);

describe('SessionPreviewOverlay', () => {
  it('renders the transcript rows and every menu item for an open target', () => {
    previewState.transcript.data = {
      messages: [
        { info: { id: 'm1' }, parts: [] },
        { info: { id: 'm2' }, parts: [] },
      ],
    };
    const renderer = mountOverlay();
    openPreview(
      targetWith({
        onRename: vi.fn<(title: string) => void>(),
        onDelete: vi.fn<() => void>(),
        onExit: vi.fn<() => void>(),
      })
    );

    expect(renderer.root.findAllByType('MessageBubble')).toHaveLength(2);
    expect(textWith(renderer, BASE_TARGET.title)).toHaveLength(1);
    for (const label of [
      i18n.t('agents.sessionRow.copyId'),
      i18n.t('common.rename'),
      i18n.t('agentChat.remoteSession.exitSession'),
      i18n.t('agents.sessionRow.deleteSession'),
      i18n.t('common.cancel'),
    ]) {
      expect(textWith(renderer, label)).toHaveLength(1);
    }
  });

  it('shows the empty copy when the transcript has no messages', () => {
    previewState.transcript.data = { messages: [] };
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    expect(textWith(renderer, i18n.t('agentChat.session.emptyTitle'))).toHaveLength(1);
    expect(textWith(renderer, i18n.t('agentChat.session.emptyDescription'))).toHaveLength(1);
    expect(renderer.root.findAllByType('MessageBubble')).toHaveLength(0);
  });

  it('shows the transcript skeleton while the first page loads', () => {
    previewState.transcript.isLoading = true;
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    expect(renderer.root.findAllByType('SessionSkeletonMessages')).toHaveLength(1);
    expect(textWith(renderer, i18n.t('agentChat.session.emptyTitle'))).toHaveLength(0);
  });

  it('offers a working Retry for a retryable transcript failure', () => {
    previewState.transcript.isError = true;
    previewState.transcript.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    expect(textWith(renderer, i18n.t('queryError.serverTitle'))).toHaveLength(1);
    pressByLabel(renderer, i18n.t('common.retry'));
    expect(previewState.transcript.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders no Retry for a non-retryable transcript failure', () => {
    previewState.transcript.isError = true;
    previewState.transcript.error = { data: { code: 'NOT_FOUND' } };
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    expect(textWith(renderer, i18n.t('common.notFound'))).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: i18n.t('common.retry') })
    ).toHaveLength(0);
  });

  it('closes the preview before a menu item runs its handler', () => {
    const observed: { visible: boolean | null } = { visible: null };
    const renderer = mountOverlay();
    openPreview(
      targetWith({
        onExit: () => {
          observed.visible = getSessionPreviewSnapshot().visible;
        },
      })
    );

    pressByLabel(renderer, i18n.t('agentChat.remoteSession.exitSession'));
    expect(observed.visible).toBe(false);
  });

  it('keeps the delete confirmation as the menu item action', () => {
    const renderer = mountOverlay();
    openPreview(targetWith({ onDelete: vi.fn<() => void>() }));

    pressByLabel(renderer, i18n.t('agents.sessionRow.deleteSession'));
    expect(previewState.alert).toHaveBeenCalledWith(
      i18n.t('agents.sessionRow.deleteTitle'),
      i18n.t('agents.sessionRow.deleteMessage'),
      expect.anything()
    );
  });

  it('keeps the iOS rename prompt and releases after it is dismissed', () => {
    const renderer = mountOverlay();
    openPreview(targetWith({ onRename: vi.fn<(title: string) => void>() }));

    pressByLabel(renderer, i18n.t('common.rename'));
    expect(previewState.prompt).toHaveBeenCalledTimes(1);
    // The native prompt is not part of the preview tree, so the close already
    // released the target.
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('holds the target while the Android rename dialog is open', () => {
    previewState.platformOS = 'android';
    const renderer = mountOverlay();
    openPreview(targetWith({ onRename: vi.fn<(title: string) => void>() }));

    pressByLabel(renderer, i18n.t('common.rename'));
    const dialogs = renderer.root.findAllByType('RenameModal');
    expect(dialogs).toHaveLength(1);
    // The overlay must survive the exit animation so the dialog stays on screen.
    expect(getSessionPreviewSnapshot().target).not.toBeNull();

    const dialog = dialogs[0];
    if (!dialog) {
      throw new Error('missing rename dialog');
    }
    (dialog.props.onClose as () => void)();
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('releases the target when Cancel closes the preview', () => {
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    pressByLabel(renderer, i18n.t('common.cancel'));
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('releases the target when the backdrop is tapped', () => {
    const renderer = mountOverlay();
    openPreview(targetWith({}));

    pressByLabel(renderer, i18n.t('common.close'));
    expect(getSessionPreviewSnapshot().target).toBeNull();
  });

  it('shows the needs-input state of a live session from the polled row', () => {
    previewState.row.data = {
      status: 'question',
      status_updated_at: '2026-07-01T00:00:00.000Z',
      total_cost_microdollars: null,
    };
    const renderer = mountOverlay();
    openPreview(targetWith({ live: true, statusKind: 'running', needsInput: false }));

    expect(textWith(renderer, i18n.t('agents.sessionRow.needsInput'))).toHaveLength(1);
  });
});
