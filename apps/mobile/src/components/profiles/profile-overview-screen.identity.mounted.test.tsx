// The Profile Overview screen's identity, its settings-row counts and the
// destructive actions that follow from them.
import {
  h,
  resetProfileOverview,
  rowCounts,
} from '@/components/profiles/profile-overview-screen.harness.test-helpers';
import {
  findAll,
  findField,
  findOne,
  findRow,
  mountScreen,
  pressDelete,
  testProfile,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

beforeEach(() => {
  resetProfileOverview();
});

describe('ProfileOverviewScreen identity', () => {
  it('renders the overview in TabScreenScrollView, including the delete action', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer } = await mountScreen();

    // The name takes the title slot the loading bar held: one heading, no
    // placeholder left behind it.
    expect(findOne(renderer.root, 'ScreenHeader').props.titleContent).toBeUndefined();

    // The shared scroll view reserves the tab bar (and, while the keyboard is
    // up, the IME) below its viewport, so the destructive action at the end of
    // the content stays reachable above both. A bare ScrollView parked it
    // behind the bar.
    const scroll = findOne(renderer.root, 'TabScreenScrollView');
    // The metadata form's multiline Description (and any field reached by
    // scrolling) must come out from behind the keyboard; the native iOS content
    // inset is what reveals the focused field, and TabScreenScrollView then
    // leaves the IME to it instead of reserving the frame margin twice.
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(findAll(renderer.root, 'ScrollView')).toHaveLength(0);

    const buttons = findAll(renderer.root, 'Button');
    expect(buttons).toHaveLength(2);
    expect(findAll(scroll, 'Button')).toHaveLength(buttons.length);
  });

  it('empty: an empty profile still renders all seven rows, with no count beside them', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer } = await mountScreen();

    expect(rowCounts(renderer.root)).toEqual(Array.from({ length: 7 }, () => null));
    expect(findRow(renderer.root, 'Import config')).toBeDefined();
  });

  it('happy: the default toggle calls setAsDefault and clearDefault', async () => {
    h.query.data = testProfile({ isDefault: false });
    h.query.isPending = false;

    const { renderer } = await mountScreen();

    const defaultRow = findOne(renderer.root, 'PreferenceRow');

    act(() => {
      (defaultRow.props as { onValueChange: (next: boolean) => void }).onValueChange(true);
    });
    expect(h.mutations.setAsDefault.mutate).toHaveBeenCalledWith({ profileId: 'profile-1' });

    act(() => {
      (defaultRow.props as { onValueChange: (next: boolean) => void }).onValueChange(false);
    });
    expect(h.mutations.clearDefault.mutate).toHaveBeenCalledWith({ profileId: 'profile-1' });
  });

  it('happy: confirming delete toasts and navigates back', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.deleteProfile.mutateAsync.mockResolvedValue({ success: true });

    const { renderer } = await mountScreen();

    await pressDelete(renderer.root, h.confirm);

    await waitFor(() => h.mutations.deleteProfile.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteProfile.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
    });
    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('non-retryable: a PRECONDITION_FAILED delete shows deleteBlocked and stays', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.deleteProfile.mutateAsync.mockRejectedValue({
      data: { code: 'PRECONDITION_FAILED' },
    });

    const { renderer } = await mountScreen();

    await pressDelete(renderer.root, h.confirm);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith(
      'This profile is used by a webhook trigger. Remove it from those triggers first.'
    );
    expect(h.back).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Profile name')).toBeTruthy();
  });

  it('retryable: a generic delete failure with no usable message adds deleteFailed', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = Object.assign(new Error('Unavailable'), { message: '' });
    h.mutations.deleteProfile.mutateAsync.mockRejectedValue(error);

    const { renderer } = await mountScreen();

    await pressDelete(renderer.root, h.confirm);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't delete profile");
    expect(h.back).not.toHaveBeenCalled();
  });
});
