import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AdvancedConfigPanel } from './advanced-config-panel';

/**
 * The panel's Save-as-Profile ownership: a settlement from a sheet that has
 * since been closed and reopened must not close the one that replaced it, which
 * a boolean open flag could not express.
 */

const sheetMock = vi.hoisted(() => ({
  /** The onClose each mounted sheet was handed, in mount order. */
  closes: [] as (() => void)[],
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/components/agents/advanced-config-editors', () => ({
  ManualEnvVarsEditor: 'ManualEnvVarsEditor',
  ManualSetupCommandsEditor: 'ManualSetupCommandsEditor',
}));

// The sheet is replaced by a marker that records the onClose it was given, so
// the test drives the closure the panel owns rather than the sheet's fields.
vi.mock('@/components/agents/save-profile-sheet', () => ({
  SaveProfileSheet: (props: { onClose: () => void }) => {
    sheetMock.closes.push(props.onClose);
    return createElement('SaveProfileSheet', props);
  },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/tap-target', () => ({ ROW_TARGET_CLASS: 'row' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => ({
    orgProfiles: [],
    personalProfiles: [],
    combined: [],
    effectiveDefaultId: null,
  }),
  useAgentProfileMutations: () => ({
    create: { mutateAsync: vi.fn() },
    setVar: { mutateAsync: vi.fn() },
    setCommands: { mutateAsync: vi.fn() },
    setAsDefault: { mutateAsync: vi.fn() },
  }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(AdvancedConfigPanel, {
        selectedProfileId: null,
        onSelectProfile: vi.fn(),
        manualVars: [{ key: 'API_KEY', value: 'secret', isSecret: true }],
        manualCommands: [],
        onManualVarsChange: vi.fn(),
        onManualCommandsChange: vi.fn(),
      })
    );
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the panel did not render');
  }
  return renderer;
}

/** Expands the disclosure, then presses the control labelled `label`. */
function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const target = renderer.root
    .findAll(node => typeof node.type === 'string')
    .find(node => node.props.accessibilityLabel === label);
  if (!target) {
    throw new Error(`no pressable labelled ${label}`);
  }
  act(() => {
    (target.props.onPress as () => void)();
  });
}

beforeEach(() => {
  sheetMock.closes.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('AdvancedConfigPanel save sheet ownership', () => {
  it('a late onClose from a closed sheet leaves the reopened sheet open', () => {
    const renderer = mount();

    press(renderer, 'Advanced Configuration');
    press(renderer, 'Save as Profile');
    expect(renderer.root.findAllByType('SaveProfileSheet' as never)).toHaveLength(1);
    const firstClose = sheetMock.closes[0];
    if (!firstClose) {
      throw new Error('the first sheet was not mounted');
    }

    // The person dismisses it, then opens it again.
    act(() => {
      firstClose();
    });
    expect(renderer.root.findAllByType('SaveProfileSheet' as never)).toHaveLength(0);
    press(renderer, 'Save as Profile');
    const reopened = renderer.root.findAllByType('SaveProfileSheet' as never);
    expect(reopened).toHaveLength(1);

    // A settlement from the closed sheet arrives late: it must not close the
    // sheet that replaced it.
    act(() => {
      firstClose();
    });
    expect(renderer.root.findAllByType('SaveProfileSheet' as never)).toHaveLength(1);
  });
});