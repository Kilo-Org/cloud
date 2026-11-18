import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetFormDraftsForTests } from '@/lib/form-draft';
import { type ProfileFormDraft, useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

type Row = { id: string };
type Notes = { conflict: boolean };

const firstRow: Row = { id: 'one' };
const secondRow: Row = { id: 'two' };
const rows: readonly Row[] = [firstRow, secondRow];
const noNotes: Notes = { conflict: false };

/** The live hook value, read back through the mounted probe. */
const seen: { current: ProfileFormDraft<Row, Notes> | undefined } = { current: undefined };

function Probe({ scope, items }: Readonly<{ scope: string; items: readonly Row[] }>) {
  seen.current = useProfileFormDraft(scope, items, noNotes);
  return null;
}

function mount(scope: string, items: readonly Row[] = rows) {
  return renderWithProviders(createElement(Probe, { scope, items }));
}

function current(): ProfileFormDraft<Row, Notes> {
  if (seen.current === undefined) {
    throw new Error('the probe never rendered');
  }
  return seen.current;
}

describe('useProfileFormDraft', () => {
  beforeEach(() => {
    resetFormDraftsForTests();
    seen.current = undefined;
  });

  it('reopens the same form with its notes after a remount', async () => {
    const first = await mount('profiles:test:remount');
    act(() => {
      current().startEdit(secondRow);
      current().setNotes({ conflict: true });
    });
    first.unmount();

    const second = await mount('profiles:test:remount');
    expect(current().isOpen).toBe(true);
    expect(current().editing).toBe(secondRow);
    expect(current().notes).toEqual({ conflict: true });
    second.unmount();
  });

  it('drops the form and its notes when it closes, so the next open starts clean', async () => {
    const { unmount } = await mount('profiles:test:close');
    act(() => {
      current().startAdd();
      current().setNotes({ conflict: true });
    });
    act(() => {
      current().close();
    });
    expect(current().isOpen).toBe(false);
    expect(current().notes).toEqual(noNotes);

    act(() => {
      current().startAdd();
    });
    expect(current().isOpen).toBe(true);
    expect(current().notes).toEqual(noNotes);
    unmount();
  });

  it('reads an edit whose row is gone as closed rather than opening the add form', async () => {
    const first = await mount('profiles:test:orphan');
    act(() => {
      current().startEdit(firstRow);
    });
    first.unmount();

    const second = await mount('profiles:test:orphan', [secondRow]);
    expect(current().isOpen).toBe(false);
    expect(current().editing).toBe(null);
    second.unmount();
  });

  it('bumps the generation on every open and close, so a late save is stale', async () => {
    const { unmount } = await mount('profiles:test:generation');
    const initial = current().generation();
    act(() => {
      current().startAdd();
    });
    const opened = current().generation();
    expect(opened).toBeGreaterThan(initial);
    act(() => {
      current().close();
    });
    expect(current().generation()).toBeGreaterThan(opened);
    unmount();
  });
});
