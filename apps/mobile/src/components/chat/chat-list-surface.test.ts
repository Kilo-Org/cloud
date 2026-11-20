import { describe, expect, it } from 'vitest';

import { type ChatListSurfaceInputs, selectChatListSurface } from './chat-list-surface';

/** Everything answered: one empty, successful list and a loaded catalog. */
const answered: ChatListSurfaceInputs = {
  chatCount: 0,
  listAnswered: true,
  listFailed: false,
  listLoading: false,
  hasPlace: true,
  catalogAnswered: true,
  catalogLoading: false,
  catalogStartable: true,
  offline: false,
};

describe('selectChatListSurface', () => {
  it('names a failed list instead of an empty one', () => {
    expect(selectChatListSurface({ ...answered, listFailed: true })).toEqual({
      kind: 'list-error',
    });
  });

  it('names a list that has no scope to read', () => {
    expect(selectChatListSurface({ ...answered, hasPlace: false, listAnswered: false })).toEqual({
      kind: 'list-error',
    });
  });

  it('waits while the list read is in flight', () => {
    expect(selectChatListSurface({ ...answered, listAnswered: false, listLoading: true })).toEqual({
      kind: 'loading',
    });
  });

  it('names the offline catalog rather than an empty list', () => {
    expect(
      selectChatListSurface({
        ...answered,
        catalogAnswered: false,
        catalogStartable: false,
        offline: true,
      })
    ).toEqual({ kind: 'catalog-error', offline: true });
  });

  it('names a catalog failure that is not offline', () => {
    expect(
      selectChatListSurface({ ...answered, catalogAnswered: false, catalogStartable: false })
    ).toEqual({ kind: 'catalog-error', offline: false });
  });

  it('waits while the catalog is in flight and nothing can start a chat', () => {
    expect(
      selectChatListSurface({
        ...answered,
        catalogAnswered: false,
        catalogLoading: true,
        catalogStartable: false,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps answered rows when the catalog fails', () => {
    // The list is the device's own answer; a catalog failure must not replace
    // readable rows (or the New-chat button) with a full-screen error.
    expect(selectChatListSurface({ ...answered, chatCount: 2, catalogAnswered: false })).toEqual({
      kind: 'rows',
    });
    expect(
      selectChatListSurface({ ...answered, chatCount: 2, catalogAnswered: false, offline: true })
    ).toEqual({ kind: 'rows' });
  });

  it('keeps the empty state when a model is already known', () => {
    // Cached rows, a backend or an on-device model still start a chat, so the
    // catalog's failure changes nothing the person can do.
    expect(selectChatListSurface({ ...answered, catalogAnswered: false })).toEqual({
      kind: 'empty',
    });
    expect(
      selectChatListSurface({ ...answered, catalogAnswered: false, catalogLoading: true })
    ).toEqual({ kind: 'empty' });
  });

  it('is empty only on an answered empty list', () => {
    expect(selectChatListSurface(answered)).toEqual({ kind: 'empty' });
    expect(selectChatListSurface({ ...answered, chatCount: 1 })).toEqual({ kind: 'rows' });
  });

  it('keeps answered rows through an outage', () => {
    expect(selectChatListSurface({ ...answered, chatCount: 2, offline: true })).toEqual({
      kind: 'rows',
    });
  });
});
