import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePickerScreen from '@/app/(app)/agent-chat/profile-picker';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { renderWithProviders } from '@/test/render-with-providers';

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const slot = vi.hoisted(() => ({
  bridge: undefined as Record<string, unknown> | undefined,
  get: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => router }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: () => undefined,
  profilePickerSlot: { get: slot.get, clear: slot.clear },
}));

vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
vi.mock('@/components/agents/profile-picker-sheet', () => ({
  ProfilePickerSheet: 'ProfilePickerSheet',
}));

vi.mock('@/components/agents/use-effective-agent-profile', () => ({
  useEffectiveAgentProfile: () => ({
    allProfiles: [],
    effectiveDefaultId: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

function findSheet(renderer: ReactTestInstance): ReactTestInstance {
  const [sheet] = renderer.findAllByType('ProfilePickerSheet' as never);
  if (!sheet) {
    throw new Error('the profile picker sheet did not render');
  }
  return sheet;
}

function mount() {
  return renderWithProviders(createElement(ProfilePickerScreen));
}

beforeEach(() => {
  router.back.mockReset();
  router.push.mockReset();
  slot.get.mockReset();
  slot.clear.mockReset();
  slot.get.mockReturnValue({
    organizationId: undefined,
    selectedOverrideProfileId: null,
    repoBindingProfileId: null,
    onSelect: vi.fn(),
  });
});

describe('ProfilePickerScreen', () => {
  it('opens the profile list in the stack that owns the picker, not the Profile tab', async () => {
    const { renderer, unmount } = await mount();

    act(() => {
      (findSheet(renderer.root).props as { onManageProfiles: () => void }).onManageProfiles();
    });

    // The picker is a root-stack sheet: the list it opens has to join that same
    // stack, or Back lands on the Profile tab root instead of the composer.
    expect(router.push).toHaveBeenCalledWith(getProfilesPath('app'));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(slot.clear).toHaveBeenCalledTimes(1);

    unmount();
  });
});
