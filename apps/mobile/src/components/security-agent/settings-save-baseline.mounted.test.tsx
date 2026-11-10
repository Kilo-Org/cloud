// Saving a Security Agent settings screen must clear the dirty state on its
// own render. The saved baseline used to live in a ref, so a successful save
// updated nothing React could see: the header action stayed "dirty" and the
// back guard still believed there were unsaved changes until an unrelated
// re-render. This suite drives the real `getSettingsDirtyState` against the
// real screen and reads the `dirty` flag the header action receives.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AutomationSettingsScreen } from './automation-settings-screen';

const config = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const save = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
}));

const toggleRows = vi.hoisted(() => ({
  rows: [] as {
    title: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }[],
}));
const saveButton = vi.hoisted(() => ({
  dirty: false,
  onSave: null as (() => Promise<void>) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Alert: { alert: vi.fn() },
}));
vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentCapability: () => ({ canManage: true }),
  useSecurityAgentConfig: () => config,
  useSaveSecurityAgentConfig: () => save,
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-settings-back-guard', () => ({
  useSecurityAgentSettingsRedirect: () => undefined,
  useSettingsBackGuard: () => ({
    onBack: () => undefined,
    skipNextGuardRef: { current: false },
    dialog: null,
  }),
}));
vi.mock('@/components/security-agent/settings-pill-group', () => ({
  PillGroup: () => null,
}));
vi.mock('@/components/security-agent/settings-save-button', () => ({
  SettingsSaveButton: (props: { dirty: boolean; onSave: () => Promise<void> }) => {
    saveButton.dirty = props.dirty;
    saveButton.onSave = props.onSave;
    return null;
  },
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: (props: {
    title: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    toggleRows.rows.push(props);
    return null;
  },
}));
vi.mock('@/components/platform-error-screen', () => ({ PlatformErrorScreen: () => null }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { headerRight?: unknown }) => props.headerRight ?? null,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: unknown }) => props.children,
}));

const AUTO_DISMISS_ROW_TITLE = 'Enable auto-dismiss';

const loadedConfig = {
  isEnabled: true,
  autoAnalysisEnabled: false,
  autoAnalysisMinSeverity: 'high',
  autoAnalysisIncludeExisting: false,
  autoRemediationEnabled: false,
  autoRemediationMinSeverity: 'high',
  autoRemediationIncludeExisting: false,
  autoRemediationRequireApproval: true,
  autoDismissEnabled: false,
  autoDismissConfidenceThreshold: 'high',
};

function renderScreen() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(AutomationSettingsScreen, { scope: 'personal' })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function autoDismissRow() {
  const row = toggleRows.rows.find(r => r.title === AUTO_DISMISS_ROW_TITLE);
  if (!row) {
    throw new Error('auto-dismiss toggle row not found');
  }
  return row;
}

describe('Automation settings saved baseline', () => {
  beforeEach(() => {
    toggleRows.rows = [];
    saveButton.dirty = false;
    saveButton.onSave = null;
    config.data = loadedConfig;
    save.mutateAsync.mockReset();
    save.mutateAsync.mockResolvedValue({});
  });

  it('clears the header action’s dirty flag on the save’s own render', async () => {
    const renderer = renderScreen();

    expect(autoDismissRow().value).toBe(false);
    expect(saveButton.dirty).toBe(false);

    act(() => {
      autoDismissRow().onValueChange(true);
    });
    expect(saveButton.dirty).toBe(true);

    await act(async () => {
      await saveButton.onSave?.();
    });

    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ autoDismissEnabled: true })
    );
    // No unrelated re-render: the save itself must publish the new baseline.
    expect(saveButton.dirty).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });
});
