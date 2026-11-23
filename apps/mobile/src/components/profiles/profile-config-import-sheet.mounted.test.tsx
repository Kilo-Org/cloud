// The import sheet's own permission gate: a `read-only` verdict closes it, and
// `resolving` keeps the pasted config on screen because the role is not known.
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { toast as mockedToast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ImportPreviewInput } from '@/components/profiles/config-import-preview-model';
import { ProfileConfigImportSheet } from '@/components/profiles/profile-config-import-sheet';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
  confirm: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));

const onClose = vi.fn();

/** A preview with one importable section, so the header's Done submits an apply. */
const PREVIEW: ImportPreviewInput = {
  agents: {
    added: [{ id: 'reviewer', item: { slug: 'reviewer', name: 'Reviewer', config: {} } }],
    changed: [],
  },
  commands: { added: [], changed: [] },
  skills: { added: [], changed: [] },
  instructions: { added: [], changed: [] },
  issues: [],
};

/** The server's refusal, as the apply reports it. */
const REFUSAL = 'Only organization owners and admins can change this profile';

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
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
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

/** The first host node of `type`, or a loud failure naming what the suite expected. */
function propNode(root: ReactTestInstance, type: string, what: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (node === undefined) {
    throw new Error(`${what} was not rendered`);
  }
  return node;
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

/** The pasted-config field, whose text the sheet keeps in a ref. */
function changePastedConfig(root: ReactTestInstance, value: string): void {
  const handler = propNode(root, 'FormField', 'the pasted-config field').props as {
    onChangeText?: (v: string) => void;
  };
  if (handler.onChangeText === undefined) {
    throw new Error('the pasted-config field takes no text');
  }
  handler.onChangeText(value);
}

/** Press the sheet header's Done control, which previews or applies. */
async function pressHeaderDone(root: ReactTestInstance): Promise<void> {
  const handler = propNode(root, 'SheetHeader', 'the sheet header').props as {
    onDone?: () => Promise<void> | void;
  };
  await act(async () => {
    await handler.onDone?.();
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

  it('read-only with a pasted draft: closes without asking', async () => {
    const { renderer, queryClient, unmount } = await mountSheet();
    act(() => {
      changePastedConfig(renderer.root, JSON.stringify({ agents: [] }));
    });

    // The sheet lasts only as long as the permission that offers it: a draft
    // that was never previewed is dropped with it, not rung through the guard.
    h.permission = 'read-only';
    await rerenderSheet(renderer, queryClient);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('an apply refused after the sheet unmounted: the refusal reaches the toast', async () => {
    h.preview.mockResolvedValue(PREVIEW);
    const apply = Promise.withResolvers<unknown>();
    h.apply.mockReturnValue(apply.promise);

    const { renderer, unmount } = await mountSheet();
    act(() => {
      changePastedConfig(renderer.root, JSON.stringify({ agents: [] }));
    });
    await pressHeaderDone(renderer.root);
    await pressHeaderDone(renderer.root);

    // Any close path unmounts the sheet, so the refusal has no inline note to
    // land in even when the permission still allows the write.
    unmount();
    await act(async () => {
      apply.reject(new Error(REFUSAL));
      await Promise.resolve();
    });

    expect(mockedToast.error).toHaveBeenCalledWith(REFUSAL);
  });

  it('read-only while an apply is refused: the refusal reaches the toast', async () => {
    h.preview.mockResolvedValue(PREVIEW);
    const apply = Promise.withResolvers<unknown>();
    h.apply.mockReturnValue(apply.promise);

    const { renderer, queryClient, unmount } = await mountSheet();
    act(() => {
      changePastedConfig(renderer.root, JSON.stringify({ agents: [] }));
    });
    // The header's Done previews first and applies once a preview is on screen.
    await pressHeaderDone(renderer.root);
    await pressHeaderDone(renderer.root);

    // The permission turns read-only while the apply is in flight, so the sheet
    // is closing when the server refuses: the note has to outlive it.
    h.permission = 'read-only';
    await rerenderSheet(renderer, queryClient);
    await act(async () => {
      apply.reject(new Error(REFUSAL));
      await Promise.resolve();
    });

    expect(mockedToast.error).toHaveBeenCalledWith(REFUSAL);

    unmount();
  });
});
