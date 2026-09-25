/* eslint-disable max-lines -- the header title-state suite and the v2 session.updated title suite share one module. */
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import {
  displaySessionTitle,
  getSessionDetailRenameState,
  initialRenameState,
  titleFromSessionUpdatedEvent,
} from './session-detail-rename-state';

describe('getSessionDetailRenameState', () => {
  const fallbackTitle = 'Session';

  it('returns a non-interactive title while the session record is still loading', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: false,
        serverTitle: undefined,
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: false,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('exposes the title as interactive once the current session record is loaded', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Original',
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: 'Original',
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('falls back to the caller title when the server title is the creation placeholder', () => {
    // A session created through cloud-agent-next carries
    // `New session - <ISO instant>` (or the child variant) until it is named.
    // The header must never paint that machine string, whether it arrived as
    // the fetched server title or as a live `session.updated` title (which
    // reaches the hook as `serverTitle`).
    const state = getSessionDetailRenameState({
      fallbackTitle: 'Session',
      isLoaded: true,
      serverTitle: 'New session - 2026-09-22T17:26:31.465Z',
      renameState: { ...initialRenameState(), isModalOpen: true },
    });
    expect(state.title).toBe('Session');
    expect(state.modalInitialValue).toBe('Session');
    expect(state.title).not.toContain('2026-09-22');
  });

  it('returns a real caller fallback unchanged and normalizes a placeholder one', () => {
    // The screen pre-sanitizes the cached list title before it becomes
    // `fallbackTitle` (session-detail-content.tsx), so a real name passes
    // through untouched. The helper normalizes a placeholder or blank fallback
    // to the generic label as well, so a machine timestamp can never reach the
    // header even if one is handed in.
    for (const fallback of ['Session', 'Fix login bug']) {
      const state = getSessionDetailRenameState({
        fallbackTitle: fallback,
        isLoaded: true,
        serverTitle: undefined,
        renameState: initialRenameState(),
      });
      expect(state.title).toBe(fallback);
    }
    for (const fallback of ['New session - 2026-09-22T17:26:31.465Z', '   ']) {
      const state = getSessionDetailRenameState({
        fallbackTitle: fallback,
        isLoaded: true,
        serverTitle: undefined,
        renameState: initialRenameState(),
      });
      expect(state.title).toBe(i18n.t('agentChat.session.title'));
    }
  });

  it('falls back to the fallback name when the server title is a generated placeholder', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'New session - 2026-09-22T02:05:22.778Z',
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('keeps a real server title over the fallback name', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Fix the session header',
        renameState: initialRenameState(),
      }).title
    ).toBe('Fix the session header');
  });

  it('hides interactivity when fetched data belongs to a different session', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: false,
        serverTitle: undefined,
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: false,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('hides a backend default title behind the fallback copy', () => {
    // `New session - <ISO>` is machine output, not a user-facing title.
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'New session - 2026-09-20T08:10:35.172Z',
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('shows the localized fallback instead of the backend placeholder title', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'New session - 2026-09-22T02:05:22.778Z',
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('shows the localized fallback for a child-session placeholder title', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Child session - 2026-09-22T02:05:22.778Z',
        renameState: initialRenameState(),
      }).title
    ).toBe(fallbackTitle);
  });

  it('shows the localized fallback for a blank server title', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: '   ',
        renameState: initialRenameState(),
      }).title
    ).toBe(fallbackTitle);
  });

  it('keeps a real server title unchanged', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Fix login',
        renameState: initialRenameState(),
      }).title
    ).toBe('Fix login');
  });

  it('seeds the rename modal with the localized fallback for a placeholder title', () => {
    // The placeholder must not be editable as-is: the header shows "Session",
    // so the modal must open on "Session" too.
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'New session - 2026-09-22T02:05:22.778Z',
        renameState: { ...initialRenameState(), isModalOpen: true },
      }).modalInitialValue
    ).toBe(fallbackTitle);
  });

  it('shows the fallback label when the loaded record still carries the backend placeholder', () => {
    // A fresh session is seeded with `New session - ${ISO}`; the app must
    // paint its own label, never the machine string.
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'New session - 2026-09-22T01:09:45.623Z',
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('shows the fallback label when the loaded record carries a blank title', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: '   ',
        renameState: initialRenameState(),
      }).title
    ).toBe(fallbackTitle);
  });

  it('shows the optimistic override in the header when one is pending', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Original',
        renameState: { ...initialRenameState(), optimisticTitle: 'Pending' },
      })
    ).toEqual({
      title: 'Pending',
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  it('seeds the modal with the current title only while it is open', () => {
    const open = getSessionDetailRenameState({
      fallbackTitle,
      isLoaded: true,
      serverTitle: 'Original',
      renameState: { ...initialRenameState(), isModalOpen: true },
    });
    expect(open.modalInitialValue).toBe('Original');
    expect(open.isTitleInteractive).toBe(true);
    expect(open.isModalOpen).toBe(true);

    const closed = getSessionDetailRenameState({
      fallbackTitle,
      isLoaded: true,
      serverTitle: 'Original',
      renameState: initialRenameState(),
    });
    expect(closed.modalInitialValue).toBeNull();
    expect(closed.isModalOpen).toBe(false);
  });

  it('seeds the modal with the optimistic override when one is pending', () => {
    // The modal should always start from whatever the header is currently
    // showing so re-opening after a prior optimistic update still presents
    // the live value.
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: 'Original',
        renameState: { ...initialRenameState(), isModalOpen: true, optimisticTitle: 'Pending' },
      }).modalInitialValue
    ).toBe('Pending');
  });

  it('falls back to the untitled copy for a loaded session whose server title normalized away', () => {
    // A `New session - <ISO>` placeholder is normalized to undefined by
    // displaySessionTitle at the data boundary; the header then shows the
    // short fallback in full instead of an ellipsized timestamp.
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: undefined,
        renameState: initialRenameState(),
      })
    ).toEqual({
      title: fallbackTitle,
      isTitleInteractive: true,
      modalInitialValue: null,
      isModalOpen: false,
    });
  });

  const placeholderTitle = 'New session - 2026-09-21T15:44:47.176Z';

  it('replaces the server creation-default title with the fallback label', () => {
    // The server stamps `New session - <ISO timestamp>` at creation and only
    // replaces it after the first message. The header must never paint it.
    const state = getSessionDetailRenameState({
      fallbackTitle,
      isLoaded: true,
      serverTitle: placeholderTitle,
      renameState: initialRenameState(),
    });
    expect(state.title).toBe(fallbackTitle);
    expect(state.title).not.toContain('2026-09-21');
  });

  it('seeds the rename modal with the resolved label, never the placeholder', () => {
    const state = getSessionDetailRenameState({
      fallbackTitle,
      isLoaded: true,
      serverTitle: placeholderTitle,
      renameState: { ...initialRenameState(), isModalOpen: true },
    });
    expect(state.modalInitialValue).toBe(fallbackTitle);
    expect(state.modalInitialValue).not.toContain('2026-09-21');
  });

  it('resolves a placeholder fallback title to the generic Session label while loading', () => {
    // The list cache can hand the detail screen a placeholder as its
    // `cachedTitle`; the header still shows the generic label, not a
    // timestamp, while the session record loads.
    const state = getSessionDetailRenameState({
      fallbackTitle: placeholderTitle,
      isLoaded: false,
      serverTitle: undefined,
      renameState: initialRenameState(),
    });
    expect(state.title).toBe(i18n.t('agentChat.session.title'));
    expect(state.title).toBe('Session');
    expect(state.title).not.toContain('2026-09-21');
  });

  it('keeps an optimistic rename even when the typed title looks like a placeholder', () => {
    // Only server-derived titles are filtered; whatever the user typed is
    // their title.
    const state = getSessionDetailRenameState({
      fallbackTitle,
      isLoaded: true,
      serverTitle: 'Original',
      renameState: { ...initialRenameState(), optimisticTitle: placeholderTitle },
    });
    expect(state.title).toBe(placeholderTitle);
  });

  it('trims a real server title before showing it', () => {
    expect(
      getSessionDetailRenameState({
        fallbackTitle,
        isLoaded: true,
        serverTitle: '  Original  ',
        renameState: initialRenameState(),
      }).title
    ).toBe('Original');
  });
});

describe('displaySessionTitle', () => {
  it('hides the auto-title placeholder so the header shows its fallback', () => {
    expect(displaySessionTitle('New session - 2026-01-01T00:00:00.000Z')).toBeUndefined();
    expect(displaySessionTitle('Child session - 2026-01-01T00:00:00.000Z')).toBeUndefined();
  });

  it('keeps a real title untouched', () => {
    expect(displaySessionTitle('Mobile layout refinement')).toBe('Mobile layout refinement');
  });

  it('treats null, undefined and blank titles as untitled', () => {
    expect(displaySessionTitle(null)).toBeUndefined();
    expect(displaySessionTitle(undefined)).toBeUndefined();
    expect(displaySessionTitle('   ')).toBeUndefined();
  });
});

function sessionUpdatedPayload(
  over: { sessionId?: string; title?: string | null; source?: string } = {}
) {
  return {
    source: over.source ?? 'v2',
    session: {
      sessionId: over.sessionId ?? 'ses-1',
      title: over.title === undefined ? 'Auto Title' : over.title,
    },
  };
}

describe('titleFromSessionUpdatedEvent', () => {
  it('returns the title for this session', () => {
    expect(titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload())).toBe('Auto Title');
  });

  it('ignores another session', () => {
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ sessionId: 'ses-2' }))
    ).toBeUndefined();
  });

  it('ignores a blank or null title', () => {
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ title: null }))
    ).toBeUndefined();
    expect(
      titleFromSessionUpdatedEvent('ses-1', sessionUpdatedPayload({ title: '  ' }))
    ).toBeUndefined();
  });

  it('ignores a placeholder title echoed for this session', () => {
    expect(
      titleFromSessionUpdatedEvent(
        'ses-1',
        sessionUpdatedPayload({ title: 'New session - 2026-01-01T00:00:00.000Z' })
      )
    ).toBeUndefined();
  });

  it('ignores the backend placeholder so a live event cannot repaint the machine string', () => {
    expect(
      titleFromSessionUpdatedEvent(
        'ses-1',
        sessionUpdatedPayload({ title: 'New session - 2026-09-22T01:09:45.623Z' })
      )
    ).toBeUndefined();
  });
});
