import { act, createElement, type Dispatch, type SetStateAction, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InstancePickerScreen from '@/app/(app)/(tabs)/(1_kiloclaw)/chat/instance-picker';
import { FormSheetStackLaidOutContext } from '@/lib/form-sheet';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Android measures a formSheet's collapsed detent once, when the screen
 * fragment is created, from the hosting stack's height. A picker opened before
 * its KiloClaw stack has laid out must re-present itself once so the detent is
 * measured against the real height (spot-check e1); a picker opened afterwards
 * must be left alone. These tests pin both halves of that contract.
 */
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  instances: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ currentId: 'instance-1' }),
  useRouter: () => ({
    replace: mocks.replace,
    push: vi.fn(),
    back: vi.fn(),
    dismissAll: vi.fn(),
  }),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/kiloclaw/status-badge', () => ({ StatusBadge: 'StatusBadge' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', Server: 'Server' }));
vi.mock('@/lib/hooks/use-instance-context', () => ({ useAllKiloClawInstances: mocks.instances }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ foreground: '#000' }) }));

const PICKER_PATH = '/(app)/(tabs)/(1_kiloclaw)/chat/instance-picker?currentId=instance-1';

/** Setter for the harness below, so a test can flip the hosting stack to laid out. */
let setStackLaidOut: Dispatch<SetStateAction<boolean>> | undefined = undefined;

/** Hosts the picker under a stack-laid-out flag the test controls. */
function StackLayoutHarness() {
  const [laidOut, setLaidOut] = useState(false);
  setStackLaidOut = setLaidOut;
  return createElement(
    FormSheetStackLaidOutContext.Provider,
    { value: laidOut },
    createElement(InstancePickerScreen)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instances.mockReturnValue({
    data: [],
    isError: false,
    isPending: false,
    isSuccess: true,
    refetch: vi.fn(),
  });
});

describe('KiloClaw instance picker sheet host', () => {
  it('re-presents once when it mounted before its stack laid out', async () => {
    const mounted = await renderWithProviders(createElement(StackLayoutHarness));
    expect(mocks.replace).not.toHaveBeenCalled();

    await act(async () => {
      setStackLaidOut?.(true);
      await Promise.resolve();
    });
    expect(mocks.replace).toHaveBeenCalledWith(PICKER_PATH);
    expect(mocks.replace).toHaveBeenCalledOnce();

    mounted.unmount();
  });

  it('leaves a picker opened after its stack laid out alone', async () => {
    const mounted = await renderWithProviders(
      createElement(
        FormSheetStackLaidOutContext.Provider,
        { value: true },
        createElement(InstancePickerScreen)
      )
    );
    expect(mocks.replace).not.toHaveBeenCalled();

    mounted.unmount();
  });
});
