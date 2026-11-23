// The Overview's Import config gate: the sheet mounts while the read shows the
// profile, and a terminal refusal unmounts it with the draft it holds.
import {
  h,
  resetProfileOverview,
} from '@/components/profiles/profile-overview-screen.harness.test-helpers';
import {
  findAll,
  findRow,
  mountScreen,
  rerenderScreen,
  testProfile,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const IMPORT_ROW = i18n.t('profiles.importConfigTitle');

// The screen loads the sheet through `lazy`, which accepts only a component
// type, so the stub is a function that renders the host element of that name.
vi.mock('@/components/profiles/profile-config-import-sheet', () => ({
  ProfileConfigImportSheet: function ProfileConfigImportSheetStub() {
    return createElement('ProfileConfigImportSheet');
  },
}));

/** The import row's own press, the way a tap reaches it. */
function pressImportRow(root: ReactTestInstance): void {
  const row = findRow(root, IMPORT_ROW).props as { onPress: () => void };
  act(() => {
    row.onPress();
  });
}

describe('ProfileOverviewScreen import gate', () => {
  beforeEach(() => {
    resetProfileOverview();
    // The shared harness state carries no error field; clearing it here keeps a
    // refusal from leaking into the next case.
    Object.assign(h.query, { error: undefined });
  });

  it('manager: the Import config row mounts the sheet', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressImportRow(renderer.root);

    // The sheet arrives on its own chunk, so the mount is awaited.
    await waitFor(() => findAll(renderer.root, 'ProfileConfigImportSheet').length === 1);

    unmount();
  });

  it('terminal read: a refusal under the open sheet drops the sheet and the row', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();
    pressImportRow(renderer.root);
    await waitFor(() => findAll(renderer.root, 'ProfileConfigImportSheet').length === 1);

    // The server refuses the profile while its cached row is still present, so
    // the screen stops showing the content the sheet sat over.
    Object.assign(h.query, { isError: true, error: { data: { code: 'FORBIDDEN' } } });
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'ProfileConfigImportSheet')).toHaveLength(0);
    expect(findAll(renderer.root, 'ConfigureRow').map(node => node.props.title)).not.toContain(
      IMPORT_ROW
    );

    unmount();
  });

  it('retryable read: a server failure keeps the open sheet and shows the banner', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();
    pressImportRow(renderer.root);
    await waitFor(() => findAll(renderer.root, 'ProfileConfigImportSheet').length === 1);

    Object.assign(h.query, { isError: true, error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    expect(findAll(renderer.root, 'ProfileConfigImportSheet')).toHaveLength(1);
    expect(findAll(renderer.root, 'QueryError')).toHaveLength(1);

    unmount();
  });
});
