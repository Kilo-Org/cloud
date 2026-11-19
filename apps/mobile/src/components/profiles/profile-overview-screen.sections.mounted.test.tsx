// The Profile Overview screen's read states, its configuration sections and its
// metadata form, whose draft must survive a failed save and an unrelated refetch.
import {
  h,
  resetProfileOverview,
  rowCounts,
} from '@/components/profiles/profile-overview-screen.harness.test-helpers';
import {
  changeText,
  findAll,
  findField,
  findOne,
  findRow,
  mountScreen,
  pressSave,
  rerenderScreen,
  rowSubtitles,
  testProfile,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

beforeEach(() => {
  resetProfileOverview();
});

describe('ProfileOverviewScreen sections', () => {
  it('loading: renders skeleton rows and no content rows', async () => {
    const { renderer } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findAll(renderer.root, 'ConfigureRow')).toHaveLength(0);
    // The header holds a title-shaped bar while the read is out, so the heading
    // does not swap its text when the name arrives.
    expect(findOne(renderer.root, 'ScreenHeader').props.titleContent).toMatchObject({
      type: 'Skeleton',
    });
  });

  it('error: renders QueryError and Retry refetches', async () => {
    Object.assign(h.query, { isError: true, isPending: false });

    const { renderer } = await mountScreen();

    const queryError = findOne(renderer.root, 'QueryError');
    expect(queryError.props.title).toBe("Couldn't load profiles");
    act(queryError.props.onRetry as () => void);
    expect(h.query.refetch).toHaveBeenCalledTimes(1);
  });

  it('happy: seeds the fields, lists the sections, and saves the metadata', async () => {
    h.query.data = testProfile({
      varCount: 1,
      commandCount: 2,
      skillCount: 1,
    });
    h.query.isPending = false;
    h.mutations.update.mutateAsync.mockResolvedValue({ success: true });

    const { renderer } = await mountScreen();

    expect(findField(renderer.root, 'Profile name').props.defaultValue).toBe('Backend debugging');
    expect(findField(renderer.root, 'Profile description').props.defaultValue).toBe(
      'Old description'
    );
    // The seven sections in the web editor's order, then the Import config row.
    // A count is a trailing value, and a section with nothing in it shows no
    // number at all.
    expect(rowCounts(renderer.root)).toEqual(['1', '2', null, null, '1', null, null]);
    const subtitles = rowSubtitles(renderer.root);
    expect(subtitles.slice(0, 7)).toEqual(Array.from({ length: 7 }, () => undefined));
    expect(subtitles[7]).toBe('Paste a config and review its changes');

    act(() => {
      (findRow(renderer.root, 'Skills').props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenCalledWith('/profiles/profile-1/skills');

    changeText(renderer.root, 'Profile name', '  Renamed  ');
    await pressSave(renderer.root);

    await waitFor(() => h.mutations.update.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      name: 'Renamed',
      description: 'Old description',
    });
    await waitFor(() => h.success.mock.calls.length > 0);
    expect(h.success).toHaveBeenCalledWith('Updated');
  });

  it('retains edited metadata after a failed save and clears the error after an explicit retry', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = Object.assign(new Error('Unavailable'), { message: '' });
    h.mutations.update.mutateAsync
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ success: true });

    const { renderer, queryClient } = await mountScreen();

    changeText(renderer.root, 'Profile name', 'Renamed');
    changeText(renderer.root, 'Profile description', 'Retained description');
    await pressSave(renderer.root);
    await waitFor(() => findAll(renderer.root, 'AccessibleStatus').length === 1);
    expect(h.error).toHaveBeenCalledTimes(1);

    // An unrelated profile refetch must not replace the failed draft.
    h.query.data = testProfile({ varCount: 1 });
    rerenderScreen(renderer, queryClient);
    expect(findField(renderer.root, 'Profile name').props.defaultValue).toBe('Renamed');
    expect(findField(renderer.root, 'Profile description').props.defaultValue).toBe(
      'Retained description'
    );
    await pressSave(renderer.root);
    await waitFor(() => h.success.mock.calls.length === 1);

    expect(h.mutations.update.mutateAsync.mock.calls.map(([input]) => input)).toEqual([
      { profileId: 'profile-1', name: 'Renamed', description: 'Retained description' },
      { profileId: 'profile-1', name: 'Renamed', description: 'Retained description' },
    ]);
    expect(findAll(renderer.root, 'AccessibleStatus')).toHaveLength(0);
  });

  it('keeps unsaved metadata edits when a refetch changes only updatedAt', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, queryClient } = await mountScreen();

    changeText(renderer.root, 'Profile name', 'Renamed');

    // Toggling the default invalidates the detail query; the refetched profile
    // carries a new updatedAt but the same name and description.
    h.query.data = testProfile({ isDefault: true, updatedAt: '2026-02-02T00:00:00.000Z' });
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    await pressSave(renderer.root);

    await waitFor(() => h.mutations.update.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      name: 'Renamed',
      description: 'Old description',
    });
  });
});
