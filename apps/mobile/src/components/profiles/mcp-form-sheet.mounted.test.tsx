import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';
import {
  booleanHandler,
  changeText,
  chooseType,
  fieldError,
  fieldText,
  findAll,
  findOne,
  layoutField,
  pressCancel,
  pressDone,
} from '@/components/profiles/mcp-form-sheet.test-helpers';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  confirm: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern this suite's harness already relies on). The
// stub exposes `scrollTo`, which a refused Save drives, so tests can observe it.
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    useColorScheme: () => 'light',
    View: 'View',
    Switch: 'Switch',
    ScrollView: forwardRef(function ScrollViewStub(
      props: { children?: ReactNode },
      ref: Ref<{ scrollTo: typeof h.scrollTo }>
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: h.scrollTo }));
      return createMockElement('ScrollView', props, props.children);
    }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', async () => {
  // Hoisted above this file's imports, so the stub arrives by a dynamic import.
  const { McpFormFieldStub } = await import('@/components/profiles/mcp-form-sheet.test-helpers');
  return { FormField: McpFormFieldStub };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
  }),
}));

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet(
  options: {
    existingNames?: readonly string[];
    nameConflictFromServer?: boolean;
    saveFailure?: string | null;
  } = {}
) {
  return renderWithProviders(
    createElement(McpFormSheet, {
      server: null,
      existingNames: options.existingNames ?? [],
      isSaving: false,
      nameConflictFromServer: options.nameConflictFromServer ?? false,
      saveFailure: options.saveFailure ?? null,
      onClose: () => {
        h.onClose();
      },
      onSave: (payload: unknown) => {
        h.onSave(payload);
      },
    })
  );
}

describe('McpFormSheet dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('closes an untouched sheet without asking', async () => {
    const { renderer, unmount } = await mountSheet();

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('asks before Cancel drops a typed server, and refuses Android Back while dirty', async () => {
    const { renderer, unmount } = await mountSheet();

    changeText(renderer.root, 'Server name', 'notes');

    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );
    expect(requestDismiss()).toBe(false);

    pressCancel(renderer.root);

    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.confirm.mock.calls[1]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });
    expect(h.onClose).not.toHaveBeenCalled();

    unmount();
  });
});

describe('McpFormSheet refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('scrolls to the name field when it is missing', async () => {
    const { renderer, unmount } = await mountSheet();
    layoutField(renderer.root, 'Server name', 420);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 408, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('scrolls to a bad config to the config field', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Server name', 'notes');
    changeText(renderer.root, 'Command line', 'node server.js');
    changeText(renderer.root, 'Environment (JSON)', '{"key":}');
    layoutField(renderer.root, 'Environment (JSON)', 780);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 768, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('refuses a name another server already has, under the name field', async () => {
    const { renderer, unmount } = await mountSheet({ existingNames: ['docs'] });
    changeText(renderer.root, 'Server name', 'docs');
    changeText(renderer.root, 'Command line', 'node server.js');
    layoutField(renderer.root, 'Server name', 420);

    pressDone(renderer.root);

    expect(h.onSave).not.toHaveBeenCalled();
    expect(fieldError(renderer.root, 'Server name')).toBe(i18n.t('profiles.mcp.nameConflict'));
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 408, animated: true });

    unmount();
  });

  it('shows a name conflict the server reported on the name field', async () => {
    const { renderer, unmount } = await mountSheet({ nameConflictFromServer: true });

    expect(fieldError(renderer.root, 'Server name')).toBe(i18n.t('profiles.mcp.nameConflict'));

    unmount();
  });

  it('clears a server-reported name conflict once the name changes', async () => {
    const { renderer, unmount } = await mountSheet({ nameConflictFromServer: true });

    changeText(renderer.root, 'Server name', 'another-name');

    expect(fieldError(renderer.root, 'Server name')).toBeUndefined();

    unmount();
  });

  it('renders a failed save inside the sheet', async () => {
    const { renderer, unmount } = await mountSheet({
      saveFailure: i18n.t('profiles.mcp.saveFailed'),
    });

    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.mcp.saveFailed')
    );

    unmount();
  });
});

describe('McpFormSheet server type', () => {
  const COMMAND = 'npx -y carried-command-test --flag=1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an empty URL instead of the typed command when Remote is chosen', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Command line', COMMAND);

    chooseType(renderer.root, 'remote');

    expect(findAll(renderer.root, 'FormField').map(node => node.props.label)).not.toContain(
      'Command line'
    );
    expect(fieldText(renderer.root, 'URL')).toBe('');

    unmount();
  });

  it('saves the remote URL and no command after a switch from local', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Server name', 'notes');
    changeText(renderer.root, 'Command line', COMMAND);
    chooseType(renderer.root, 'remote');
    changeText(renderer.root, 'URL', 'https://example.com/mcp');

    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledWith({
      type: 'remote',
      name: 'notes',
      enabled: true,
      config: { url: 'https://example.com/mcp' },
    });

    unmount();
  });

  it('brings back the typed command when Local is chosen again', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Command line', COMMAND);

    chooseType(renderer.root, 'remote');
    chooseType(renderer.root, 'local');

    expect(fieldText(renderer.root, 'Command line')).toBe(COMMAND);

    unmount();
  });

  it('refuses Save under the URL field when the URL is missing after a switch', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Server name', 'notes');
    changeText(renderer.root, 'Command line', COMMAND);
    chooseType(renderer.root, 'remote');

    pressDone(renderer.root);

    expect(h.onSave).not.toHaveBeenCalled();
    expect(fieldError(renderer.root, 'URL')).toBe(i18n.t('profiles.mcp.urlRequired'));

    unmount();
  });
});
