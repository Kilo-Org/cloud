import { afterEach, describe, expect, it } from 'vitest';

import {
  clearUserSessionTitles,
  getSessionDetailRenameState,
  initialRenameState,
  namedSessionTitle,
  rememberUserSessionTitle,
  titleFromSessionUpdatedEvent,
} from './session-detail-rename-state';

// A user-chosen title is not distinguishable from the backend's placeholder by
// its text alone, so the app records the titles its own rename flow wrote.
// That registry lives at module scope (it mirrors the other session-scoped
// stores), so each case starts from a clean slate.
afterEach(() => {
  clearUserSessionTitles();
});

const PLACEHOLDER = 'New session - 2026-09-22T02:05:22.778Z';

describe('a user title that looks like the backend placeholder', () => {
  it('is kept, not hidden as unnamed', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    expect(namedSessionTitle(PLACEHOLDER, 'ses-renamed')).toBe(PLACEHOLDER);
  });

  it('is compared trimmed and non-blank, matching how the rename API validates it', () => {
    rememberUserSessionTitle('ses-renamed', `  ${PLACEHOLDER}  `);
    rememberUserSessionTitle('ses-blank', '   ');
    expect(namedSessionTitle(PLACEHOLDER, 'ses-renamed')).toBe(PLACEHOLDER);
    expect(namedSessionTitle(PLACEHOLDER, 'ses-blank')).toBeUndefined();
  });

  it('does not classify an identical-looking title on another session as named', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    expect(namedSessionTitle(PLACEHOLDER, 'ses-fresh')).toBeUndefined();
  });

  it('shows up in the session header', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    expect(
      getSessionDetailRenameState({
        sessionId: 'ses-renamed',
        fallbackTitle: 'Session',
        isLoaded: true,
        serverTitle: PLACEHOLDER,
        renameState: initialRenameState(),
      }).title
    ).toBe(PLACEHOLDER);
  });

  it('is accepted from the session.updated event the rename produced', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    expect(
      titleFromSessionUpdatedEvent('ses-renamed', {
        source: 'v2',
        session: { sessionId: 'ses-renamed', title: PLACEHOLDER },
      })
    ).toBe(PLACEHOLDER);
  });

  it('is forgotten when session-scoped state clears at an account boundary', () => {
    rememberUserSessionTitle('ses-renamed', PLACEHOLDER);
    clearUserSessionTitles();
    expect(namedSessionTitle(PLACEHOLDER, 'ses-renamed')).toBeUndefined();
  });
});
