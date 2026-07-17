import { describe, expect, it } from 'vitest';

import {
  getSessionDetailRenameState,
  initialRenameState,
  type RenameState,
  renameStateReducer,
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
});

describe('renameStateReducer', () => {
  it('opens and closes the modal', () => {
    const opened = renameStateReducer(initialRenameState(), { type: 'openModal' });
    expect(opened.isModalOpen).toBe(true);

    const closed = renameStateReducer(opened, { type: 'closeModal' });
    expect(closed.isModalOpen).toBe(false);
    expect(closed).toEqual(initialRenameState());
  });

  it('sets the optimistic title while keeping the modal open on submit', () => {
    const modalOpen = renameStateReducer(initialRenameState(), { type: 'openModal' });
    const next = renameStateReducer(modalOpen, {
      type: 'submit',
      nextTitle: 'Renamed',
    });
    // RenameModal awaits onSave and only calls onClose after success. The
    // reducer must keep the modal mounted so a rejection can display the
    // inline error and allow retry.
    expect(next.isModalOpen).toBe(true);
    expect(next.optimisticTitle).toBe('Renamed');
  });

  it('restores the previously displayed title on submit failure while keeping the modal open', () => {
    const modalOpen = renameStateReducer(initialRenameState(), { type: 'openModal' });
    const submitted = renameStateReducer(modalOpen, {
      type: 'submit',
      nextTitle: 'Renamed',
    });
    const failed = renameStateReducer(submitted, {
      type: 'submitFailure',
      previousTitle: 'Original',
    });
    expect(failed.optimisticTitle).toBe('Original');
    expect(failed.isModalOpen).toBe(true);
  });

  it('restores the previously displayed title on a second failure after a successful rename', () => {
    // The authoritative server title stays A because the detail manager's
    // fetchedData is not refreshed by list-query invalidation. After the
    // first rename A→B succeeds, the displayed title is optimistic B. A
    // second rename B→C must fail back to B, not to stale A.
    const getDisplayedTitle = (state: RenameState) =>
      getSessionDetailRenameState({
        fallbackTitle: 'Session',
        isLoaded: true,
        serverTitle: 'A',
        renameState: state,
      }).title;

    let state = initialRenameState();
    state = renameStateReducer(state, { type: 'openModal' });
    state = renameStateReducer(state, { type: 'submit', nextTitle: 'B' });
    expect(getDisplayedTitle(state)).toBe('B');

    state = renameStateReducer(state, { type: 'openModal' });
    const displayedBeforeSecondSubmit = getDisplayedTitle(state);
    expect(displayedBeforeSecondSubmit).toBe('B');

    state = renameStateReducer(state, { type: 'submit', nextTitle: 'C' });
    state = renameStateReducer(state, {
      type: 'submitFailure',
      previousTitle: displayedBeforeSecondSubmit,
    });
    expect(getDisplayedTitle(state)).toBe('B');
  });

  it('clears the optimistic override when the authoritative server title changes', () => {
    const submitted = renameStateReducer(initialRenameState(), {
      type: 'submit',
      nextTitle: 'Renamed',
    });
    const updated = renameStateReducer(submitted, { type: 'serverTitleChanged' });
    expect(updated.optimisticTitle).toBeNull();
    expect(updated.isModalOpen).toBe(false);
  });

  it('closes the modal and clears the optimistic override when the session changes', () => {
    const modalOpen = renameStateReducer(initialRenameState(), { type: 'openModal' });
    const submitted = renameStateReducer(modalOpen, {
      type: 'submit',
      nextTitle: 'Renamed',
    });
    const changed = renameStateReducer(submitted, { type: 'sessionChanged' });
    expect(changed.isModalOpen).toBe(false);
    expect(changed.optimisticTitle).toBeNull();
  });
});
