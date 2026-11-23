// The import sheet's own permission gate: a `read-only` verdict closes it, and
// `resolving` keeps the pasted config on screen because the role is not known.
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ProfileConfigImportSheet } from '@/components/profiles/profile-config-import-sheet';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
  preview: vi.fn(),
  apply: vi.fn(),
}));

const onClose = vi.fn();

const SHEET_PROPS = {
  profileId: 'profile-1',
  organizationId: 'org-1',
  onClose,
};

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => h.permission,
}));
vi.mock('@/lib/hooks/use-config-import-mutations', () => ({
  useConfigImportMutations: () => ({
    previewConfigImport: { mutateAsync: h.preview },
    applyConfigImport: { mutateAsync: h.apply },
  }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111' }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/row-frame', () => ({ RowFrame: 'RowFrame' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-trailing', () => ({ renderRowTrailing: () => null }));
vi.mock('@/components/ui/section', () => ({ Section: 'Section' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ClipboardPaste: 'ClipboardPaste' }));

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function mountSheet() {
  return renderWithProviders(createElement(ProfileConfigImportSheet, SHEET_PROPS));
}

/** Re-render the open sheet against the permission the test set on `h`. */
async function rerenderSheet(renderer: ReactTestRenderer, queryClient: QueryClient): Promise<void> {
  await act(async () => {
    renderer.update(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProfileConfigImportSheet, SHEET_PROPS)
      )
    );
    await Promise.resolve();
  });
}

describe('ProfileConfigImportSheet permission gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.permission = 'allowed';
  });

  it('allowed: keeps the sheet open', async () => {
    const { renderer, unmount } = await mountSheet();

    expect(onClose).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    unmount();
  });

  it('read-only: closes the sheet once', async () => {
    const { renderer, queryClient, unmount } = await mountSheet();

    h.permission = 'read-only';
    await rerenderSheet(renderer, queryClient);

    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('resolving: keeps the sheet and its draft', async () => {
    const { renderer, queryClient, unmount } = await mountSheet();

    h.permission = 'resolving';
    await rerenderSheet(renderer, queryClient);

    expect(onClose).not.toHaveBeenCalled();
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    unmount();
  });
});
