// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  isPickerRoutePath,
  PICKER_ROUTE_NAMES,
  PICKER_ROUTE_PATHS,
  PR_PICKER,
} from './picker-routes';

const APP = fileURLToPath(new URL('../app/(app)/', import.meta.url));

describe('picker route paths', () => {
  it('names a route file for every path', () => {
    for (const path of PICKER_ROUTE_PATHS) {
      expect(existsSync(`${APP}${path.slice(1)}.tsx`), `${path} has no route file`).toBe(true);
    }
  });

  it('matches the formSheet routes the app layout registers', () => {
    const layout = readFileSync(`${APP}_layout.tsx`, 'utf8');

    for (const name of PICKER_ROUTE_NAMES) {
      expect(layout, `${name} is missing from the layout`).toContain(`name="${name}"`);
    }
  });

  it('recognises only the picker paths', () => {
    expect(isPickerRoutePath('/agent-chat/repo-picker')).toBe(true);
    expect(isPickerRoutePath('/agent-chat/new')).toBe(false);
    expect(isPickerRoutePath('/agent-chat/repo-picker-preview')).toBe(false);
    expect(isPickerRoutePath(undefined)).toBe(false);
    expect(isPickerRoutePath(null)).toBe(false);
  });

  it('declares the account picker href the opener pushes', () => {
    // The pushed href carries the route group; the list stores the pathname
    // expo-router reports once the sheet is on top. One must name the other.
    expect(PICKER_ROUTE_PATHS).toContain(PR_PICKER.replace(/^\/\(app\)\//, '/'));
  });
});

describe('opener push path', () => {
  it('records the value PR_PICKER declares, so the route list cannot drift', async () => {
    // The real expo-secure-store graph reads Expo's build-time global while it
    // imports; this suite only needs its surface to resolve.
    vi.stubGlobal('__DEV__', true);
    const push = vi.fn<(href: unknown) => void>();
    vi.doMock('expo-router', () => ({
      useRouter: () => ({ push, back: vi.fn() }),
      useFocusEffect: () => undefined,
      useNavigation: () => ({ getState: () => undefined }),
    }));
    vi.doMock('expo-secure-store', () => ({
      getItemAsync: vi.fn(() => null),
      setItemAsync: vi.fn(() => undefined),
      deleteItemAsync: vi.fn(() => undefined),
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
      WHEN_UNLOCKED: 2,
      AFTER_THIS_BOOT: 3,
      ALWAYS: 4,
    }));
    vi.doMock('@/lib/auth/secure-store-value', () => ({
      readSecureStoreValue: vi.fn(() => null),
      writeSecureStoreValue: vi.fn(() => true),
      deleteSecureStoreValue: vi.fn(() => undefined),
    }));
    vi.doMock('@/lib/auth/credentials', () => ({ exchangeLegacyToken: vi.fn() }));
    vi.doMock('@/lib/auth/trpc-unauthorized', () => ({
      setTrpcUnauthorizedHandler: vi.fn(),
    }));
    vi.doMock('@/lib/trpc', () => ({
      useTRPC: () => ({
        organizations: {
          list: { queryOptions: () => ({ queryKey: [], queryFn: () => [] }) },
        },
      }),
    }));
    vi.doMock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
    vi.doMock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:3000' }));
    vi.doMock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
    vi.doMock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
    vi.doMock('@/lib/organization-context', () => ({
      useOrganization: () => ({ organizationId: null, setOrganizationId: vi.fn() }),
    }));
    vi.doMock('@/lib/route-registry', () => ({
      contextPickerSlot: { set: vi.fn(), clearAll: vi.fn() },
      UNFENCED_ROUTE_KEY: 'unscoped',
      useRouteRegistry: vi.fn(),
    }));
    vi.doMock('react-native', () => ({
      ActivityIndicator: 'ActivityIndicator',
      Pressable: 'Pressable',
      View: 'View',
    }));
    vi.doMock('@react-navigation/native', () => ({
      useNavigation: () => ({ getState: () => undefined }),
    }));
    vi.doMock('@/components/ui/activity-indicator', () => ({
      ActivityIndicator: 'ActivityIndicator',
    }));
    vi.doMock('@/components/ui/accessible-status', () => ({
      AccessibleStatus: 'AccessibleStatus',
    }));
    vi.doMock('@/components/ui/icons', () => ({
      ChevronDown: 'ChevronDown',
      Check: 'Check',
      Info: 'Info',
    }));
    vi.doMock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
    vi.doMock('@/components/ui/text', () => ({ Text: 'Text' }));
    vi.doMock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
    vi.doMock('@/lib/hooks/use-organization-queries', () => ({ useOrganizations: () => [] }));
    vi.doMock('@/lib/a11y/tap-target', () => ({
      FIELD_TRIGGER_BODY_CLASS: '',
      FIELD_TRIGGER_FRAME_CLASS: '',
      ROW_TARGET_CLASS: '',
    }));
    vi.doMock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.join(' ') }));
    vi.doMock('@/lib/hooks/use-single-push-route', () => ({
      // The real hook pushes through the captured router; here the mock hands
      // the push straight through so the suite can read the href opener uses.
      useSinglePushRoute: () => (href: unknown) => {
        push(href);
      },
    }));
    // The dynamic import runs after `vi.doMock`, so this graph reads the mocks
    // above; a static import would have bound the real modules too early.
    const { useContextPicker } = await import('@/components/context-control');
    const fixtureOrg = {
      organizationId: 'org-a',
      organizationName: 'Repo owner',
      role: 'owner',
    } as unknown as NonNullable<Parameters<typeof useContextPicker>[0]>[number];

    useContextPicker([fixtureOrg]).openPicker();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toBe(PR_PICKER);
    vi.doUnmock('expo-router');
  });
});
