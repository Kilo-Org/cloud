/* eslint-disable max-lines -- one mounted case per panel state: both manual editors, the one atomic save, the refusal that must leave the draft intact, and the retry that must reissue the same payload */
import { createElement, type ReactNode, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AdvancedConfigPanel } from './advanced-config-panel';
import { SaveProfileSheet } from './save-profile-sheet';
import { type ProfileSelectorProfile } from './profile-selector-model';
import { MAX_SETUP_COMMANDS } from '@/components/profiles/profile-commands-model';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { SelectableText } from '@/components/ui/selectable-text';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner-native', () => ({ toast }));

const announceForAccessibility = vi.hoisted(() => vi.fn());

const listMock = vi.hoisted(() => ({
  useAgentProfileList: vi.fn(),
  useAgentProfileMutations: vi.fn(),
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => listMock);

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility },
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible === false ? null : createElement('SessionPageSheet', null, props.children),
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: (props: Record<string, unknown>) => createElement('SheetHeader', props),
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
    createElement('Button', props, props.children),
}));
vi.mock('@/components/ui/form-field', () => ({
  FormField: (props: Record<string, unknown>) => createElement('FormField', props),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Building2: 'Building2',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  GitBranch: 'GitBranch',
  Lock: 'Lock',
  Plus: 'Plus',
  Settings: 'Settings',
  Settings2: 'Settings2',
  Star: 'Star',
  Trash2: 'Trash2',
  User: 'User',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    destructive: '#f00',
    primary: '#0a84ff',
  }),
}));

const BACKEND: ProfileSelectorProfile = {
  id: 'backend',
  name: 'Backend',
  varCount: 3,
  commandCount: 1,
  isDefault: false,
  ownerType: 'user',
};

// The panel's save is one atomic `create`, so there is no other mutation to
// stub: a save that needed a follow-up write would throw here.
type Mutations = {
  create: { mutateAsync: ReturnType<typeof vi.fn> };
};

function mutations(): Mutations {
  return { create: { mutateAsync: vi.fn().mockResolvedValue({ id: 'new-1' }) } };
}

type ListState = {
  orgProfiles: ProfileSelectorProfile[];
  personalProfiles: ProfileSelectorProfile[];
  effectiveDefaultId: string | null;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
};

function listState(overrides: Partial<ListState> = {}): ListState {
  return {
    orgProfiles: [],
    personalProfiles: [BACKEND],
    effectiveDefaultId: null,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

/**
 * The session owns the profile selected after saving manual configuration.
 * The harness mirrors that ownership and records save selections.
 */
function ControlledPanel({
  organizationId,
  initialSelectedProfileId,
  initialCommands = [],
  disabled = false,
  onSelectProfile,
  onRequestReveal,
}: {
  organizationId?: string;
  initialSelectedProfileId?: string | null;
  initialCommands?: string[];
  disabled?: boolean;
  onSelectProfile?: (id: string | null) => void;
  onRequestReveal?: (contentOffset: number) => void;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    initialSelectedProfileId ?? null
  );
  // The panel's manual env vars/commands are the session's state now, so the
  // harness owns them the way the new-session body does.
  const [manualVars, setManualVars] = useState<VariableEdit[]>([]);
  const [manualCommands, setManualCommands] = useState<string[]>(initialCommands);
  return createElement(AdvancedConfigPanel, {
    organizationId,
    disabled,
    selectedProfileId,
    onSelectProfile: id => {
      onSelectProfile?.(id);
      setSelectedProfileId(id);
    },
    manualVars,
    manualCommands,
    onManualVarsChange: setManualVars,
    onManualCommandsChange: setManualCommands,
    onRequestReveal,
  });
}

function mount(
  options: {
    list?: Partial<ListState>;
    mocks?: Mutations;
    organizationId?: string;
    selectedProfileId?: string | null;
    initialCommands?: string[];
    disabled?: boolean;
    onSelectProfile?: (id: string | null) => void;
    onRequestReveal?: (contentOffset: number) => void;
  } = {}
) {
  listMock.useAgentProfileList.mockReturnValue(listState(options.list));
  listMock.useAgentProfileMutations.mockReturnValue(options.mocks ?? mutations());
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ControlledPanel, {
        organizationId: options.organizationId,
        disabled: options.disabled,
        initialCommands: options.initialCommands,
        initialSelectedProfileId: options.selectedProfileId,
        onSelectProfile: options.onSelectProfile,
        onRequestReveal: options.onRequestReveal,
      })
    );
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the panel did not render');
  }
  return renderer;
}

/**
 * Re-render the mounted harness under another account: the tree stays mounted,
 * so the harness keeps its own draft and selection and only the scope prop
 * moves.
 */
function rerenderWithScope(
  renderer: TestRenderer.ReactTestRenderer,
  organizationId?: string,
  onSelectProfile?: (id: string | null) => void
) {
  act(() => {
    renderer.update(createElement(ControlledPanel, { organizationId, onSelectProfile }));
  });
}

/**
 * A captured callback prop. Renderer props are untyped, so the value enters as
 * `unknown` and is narrowed once before the test calls through it.
 */
function isVoidHandler(value: unknown): value is () => void {
  return typeof value === 'function';
}

function invokeHandler(handler: unknown): void {
  if (!isVoidHandler(handler)) {
    throw new TypeError('expected a handler prop');
  }
  act(handler);
}

function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

/** Fire a layout event, the way the native view reports its frame. */
function layout(node: TestRenderer.ReactTestInstance, y: number) {
  act(() => {
    (node.props.onLayout as (event: { nativeEvent: { layout: { y: number } } }) => void)({
      nativeEvent: { layout: { y } },
    });
  });
}

/**
 * The panel root, or the block it renders while expanded, found by the handle
 * that identifies it inside the panel. Both are the views whose layout the
 * reveal depends on. Matched by token, not by the whole class list, so a
 * styling change to either view does not have to be mirrored here.
 */
function layoutView(renderer: TestRenderer.ReactTestRenderer, token: string) {
  const found = renderer.root
    .findAll(node =>
      String(node.props.className ?? '')
        .split(' ')
        .includes(token)
    )
    .find(node => typeof node.props.onLayout === 'function');
  if (!found) {
    throw new Error(`no view with layout class ${token}`);
  }
  return found;
}

/** The panel root: the view whose own offset the reveal reports. */
function panelRoot(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({ testID: 'advanced-config-panel' });
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAll(node => node.props.accessibilityLabel === label)
    .find(node => typeof node.props.onPress === 'function');
}

function containsText(node: TestRenderer.ReactTestInstance, text: string): boolean {
  if (node.children.some(child => typeof child === 'string' && child === text)) {
    return true;
  }
  return node.children.some(child => typeof child !== 'string' && containsText(child, text));
}

function buttonByText(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType('Button' as never).find(node => containsText(node, text));
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

/** The remaining-characters rows, which show the counted phrase as their text. */
function counterTexts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType('Text' as never)
    .filter(
      node =>
        typeof node.props.children === 'string' &&
        node.props.children.endsWith('characters remaining')
    );
}

function field(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType('FormField' as never)
    .find(instance => instance.props.label === label);
  if (!node) {
    throw new Error(`no FormField labelled ${label}`);
  }
  return node;
}

function typeInto(renderer: TestRenderer.ReactTestRenderer, label: string, value: string) {
  act(() => {
    (field(renderer, label).props.onChangeText as (value: string) => void)(value);
  });
}

function addVariable(renderer: TestRenderer.ReactTestRenderer, key: string, value: string) {
  press(buttonByText(renderer, 'Add variable'));
  typeInto(renderer, 'Key', key);
  typeInto(renderer, 'Value', value);
  press(buttonByText(renderer, 'Save'));
}

/** Expand the panel and fill one manual variable and one setup command. */
function fillManualConfig(renderer: TestRenderer.ReactTestRenderer) {
  press(byLabel(renderer, 'Advanced Configuration'));
  addVariable(renderer, 'API_KEY', 'abc');
  press(buttonByText(renderer, 'Add command'));
  typeInto(renderer, 'Command 1', 'pnpm install');
}

/** Submit the open save sheet as `name` and let the save settle. */
async function submitSave(renderer: TestRenderer.ReactTestRenderer, name: string) {
  typeInto(renderer, 'Profile name', name);
  await act(async () => {
    (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    await Promise.resolve();
  });
}

/** The line the open save sheet states, or null while it states none. */
function saveSheetMessage(renderer: TestRenderer.ReactTestRenderer): unknown {
  const sheet = renderer.root.findAll(node => node.type === SaveProfileSheet)[0];
  if (!sheet) {
    throw new Error('the save sheet was not mounted');
  }
  return sheet.findAllByType(AccessibleStatus as never)[0]?.props.message;
}

/** The one payload the manual draft must travel in, whatever the attempt. */
const MANUAL_PAYLOAD = {
  name: 'My Setup',
  description: undefined,
  vars: [{ key: 'API_KEY', value: 'abc', isSecret: false }],
  commands: ['pnpm install'],
};

/** Add a variable marked secret, so its row offers the reveal control. */
function addSecretVariable(renderer: TestRenderer.ReactTestRenderer, key: string, value: string) {
  press(buttonByText(renderer, 'Add variable'));
  typeInto(renderer, 'Key', key);
  typeInto(renderer, 'Value', value);
  const markSecret = renderer.root
    .findAll(node => node.props.accessibilityLabel === 'Mark as secret')
    .find(node => typeof node.props.onValueChange === 'function');
  if (!markSecret) {
    throw new Error('no Mark as secret switch');
  }
  act(() => {
    (markSecret.props.onValueChange as (next: boolean) => void)(true);
  });
  press(buttonByText(renderer, 'Save'));
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  announceForAccessibility.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('AdvancedConfigPanel', () => {
  it('is collapsed by default and reserves only the disclosure row', () => {
    const renderer = mount();

    const disclosure = byLabel(renderer, 'Advanced Configuration');
    expect(disclosure?.props.accessibilityState).toMatchObject({ expanded: false });
    expect(byLabel(renderer, 'Pick a profile')).toBeUndefined();
    expect(texts(renderer)).not.toContain('Environment variables');
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
  });

  it('expands to both manual editors and the summary', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(texts(renderer)).toContain('Environment variables');
    expect(texts(renderer)).toContain('Setup commands');
    // No manual config yet, so no Save as profile.
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
  });

  it('nests the revealed body under the disclosure row it belongs to', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    // Without the nesting the body's two headings read like the composer's own
    // top-level sections: same type, same start column, same gap to its control.
    const body = layoutView(renderer, 'mt-3');
    expect(String(body.props.className)).toContain('border-s-2');
    expect(String(body.props.className)).toContain('ps-3');
  });

  it('reports the disclosure as expanded once it is open', () => {
    const renderer = mount();
    expect(byLabel(renderer, 'Advanced Configuration')?.props.accessibilityState).toMatchObject({
      expanded: false,
    });

    press(byLabel(renderer, 'Advanced Configuration'));

    expect(byLabel(renderer, 'Advanced Configuration')?.props.accessibilityState).toMatchObject({
      expanded: true,
    });
  });

  it('announces the revealed guidance instead of only growing below the fold', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    // The composer sits below the fold of the new-session scroll body, so the
    // reveal rides the shared status channel: a polite live region on Android
    // and this one announcement on iOS.
    expect(announceForAccessibility).toHaveBeenCalledWith(
      i18n.t('agentChat.newSession.advancedConfigDescription')
    );
  });

  it('asks the host to reveal the panel once per expansion', () => {
    const onRequestReveal = vi.fn<(contentOffset: number) => void>();
    const renderer = mount({ onRequestReveal });

    // The collapsed panel already reports where it sits in the scroll content.
    layout(panelRoot(renderer), 812);
    press(byLabel(renderer, 'Advanced Configuration'));
    // The reveal waits for the expanded block: a scroll issued at the tap would
    // clamp against the collapsed content height and move nothing.
    expect(onRequestReveal).not.toHaveBeenCalled();

    layout(layoutView(renderer, 'mt-3'), 860);
    expect(onRequestReveal).toHaveBeenCalledTimes(1);
    expect(onRequestReveal).toHaveBeenCalledWith(812);

    // A later in-panel layout, such as a new command row, must not scroll the
    // composer under the reader again.
    layout(layoutView(renderer, 'mt-3'), 900);
    expect(onRequestReveal).toHaveBeenCalledTimes(1);

    // Collapsing reveals nothing.
    press(byLabel(renderer, 'Advanced Configuration'));
    expect(onRequestReveal).toHaveBeenCalledTimes(1);

    // Re-expanding reveals against the offset the panel last reported.
    press(byLabel(renderer, 'Advanced Configuration'));
    layout(panelRoot(renderer), 640);
    layout(layoutView(renderer, 'mt-3'), 690);
    expect(onRequestReveal).toHaveBeenCalledTimes(2);
    expect(onRequestReveal).toHaveBeenLastCalledWith(640);
  });

  it('only offers Save as profile for commands that will be persisted', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    press(buttonByText(renderer, 'Add command'));
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
    typeInto(renderer, 'Command 1', '   ');
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
    typeInto(renderer, 'Command 1', 'pnpm install');
    expect(buttonByText(renderer, 'Save as profile')).toBeDefined();
    typeInto(renderer, 'Command 1', '');
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
  });

  it('names each setup-command control after the command position', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    press(buttonByText(renderer, 'Add command'));
    typeInto(renderer, 'Command 1', 'pnpm install');
    press(buttonByText(renderer, 'Add command'));

    // The blank draft row is the second slot in the list, so its controls name
    // command 2 instead of falling back to a context-free "Move up"/"Delete".
    expect(field(renderer, 'Command 2')).toBeDefined();
    expect(
      renderer.root
        .findAll(node => typeof node.props.onPress === 'function')
        .map(node => node.props.accessibilityLabel)
    ).toEqual(
      expect.arrayContaining([
        'Move command 1 up',
        'Move command 1 down',
        'Delete command 1',
        'Move command 2 up',
        'Move command 2 down',
        'Delete command 2',
      ])
    );
  });

  it('offers Save as profile once a manual variable exists', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');

    expect(buttonByText(renderer, 'Save as profile')).toBeDefined();
    expect(texts(renderer)).toContain('1 var');
  });

  it('accepts an empty value in the session draft, matching prepare-session', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'NO_COLOR', '');

    // The profile Variables screen asks for a value; this draft editor does not,
    // because prepare-session and the web editor accept `KEY=`.
    expect(
      renderer.root.findAllByType('FormField' as never).filter(node => node.props.label === 'Value')
    ).toHaveLength(0);
    expect(texts(renderer)).toContain('1 var');
  });

  it('starts an abandoned session variable empty the next time the form opens', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    press(buttonByText(renderer, 'Add variable'));
    typeInto(renderer, 'Key', 'ABANDONED_KEY');
    typeInto(renderer, 'Value', 'abandoned-value');
    press(buttonByText(renderer, 'Cancel'));

    press(buttonByText(renderer, 'Add variable'));
    // A session draft belongs to the compose that opened it: the key and the
    // value of the cancelled attempt must not come back.
    expect(field(renderer, 'Key').props.defaultValue).toBe('');
    expect(field(renderer, 'Value').props.defaultValue).toBe('');
  });

  it('names the row reveal control after its action and reveals the draft value', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    addSecretVariable(renderer, 'API_KEY', 's3cretdraft');

    // The row control announces the action a screen-reader user takes, the
    // same copy the edit-form reveal toggle uses; the "Secret" noun names the
    // kind, not the action, and no control carries it.
    expect(byLabel(renderer, 'Secret')).toBeUndefined();
    const reveal = byLabel(renderer, 'Reveal value');
    // The name carries the state, so the control reports no separate
    // selection a reader would hear as "Reveal value, selected".
    expect(reveal?.props.accessibilityState).toBeUndefined();
    expect(texts(renderer)).not.toContain('s3cretdraft');

    press(reveal);

    expect(texts(renderer)).toContain('s3cretdraft');
    // The same control now hides the value it is showing.
    expect(byLabel(renderer, 'Reveal value')).toBeUndefined();
    press(byLabel(renderer, 'Hide value'));

    expect(texts(renderer)).not.toContain('s3cretdraft');
    expect(byLabel(renderer, 'Reveal value')).toBeDefined();
  });

  it('caps manual setup commands at the server list and row bounds', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    press(buttonByText(renderer, 'Add command'));
    expect(field(renderer, 'Command 1').props.maxLength).toBe(500);

    for (let index = 1; index < MAX_SETUP_COMMANDS; index += 1) {
      press(buttonByText(renderer, 'Add command'));
    }
    const commandFields = () =>
      renderer.root
        .findAllByType('FormField' as never)
        .filter(node => /^Command \d+$/.test(String(node.props.label)));
    expect(commandFields()).toHaveLength(MAX_SETUP_COMMANDS);
    expect(buttonByText(renderer, 'Add command')?.props.disabled).toBe(true);

    // A 21st row is refused even if the disabled control is pressed.
    press(buttonByText(renderer, 'Add command'));
    expect(commandFields()).toHaveLength(MAX_SETUP_COMMANDS);
  });

  it('keeps a busy command row a dimmed field instead of read-only text', () => {
    const renderer = mount({ disabled: true, initialCommands: ['pnpm install'] });
    press(byLabel(renderer, 'Advanced Configuration'));

    const row = field(renderer, 'Command 1');
    expect(row.props.disabled).toBe(true);
    expect(row.props.defaultValue).toBe('pnpm install');

    // A busy row is still the same field, so starting a session never reflows
    // the editor into a read-only value.
    expect(renderer.root.findAllByType(SelectableText)).toHaveLength(0);

    renderer.unmount();
  });

  it('counts the characters left on a setup command and names the bound', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    press(buttonByText(renderer, 'Add command'));
    typeInto(renderer, 'Command 1', 'a'.repeat(470));
    expect(counterTexts(renderer).map(node => node.props.children)).toEqual([
      '30 characters remaining',
    ]);
    expect(texts(renderer)).not.toContain('The command is limited to 500 characters');

    // At the bound the sentence replaces the count, so only one line is present.
    // At 470 characters the row is a command, so its label carries its position.
    typeInto(renderer, 'Command 1', 'a'.repeat(500));
    expect(counterTexts(renderer)).toEqual([]);
    expect(texts(renderer)).toContain('The command is limited to 500 characters');
  });

  it('caps a manual env-var value at the 256-character session bound', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    press(buttonByText(renderer, 'Add variable'));
    // The prepare-session input caps every inline env-var value at 256
    // characters, so the field cannot hold a value Start would be refused for.
    expect(field(renderer, 'Value').props.maxLength).toBe(256);
  });

  it('keeps manual config working with no profiles at all', () => {
    const renderer = mount({ list: { personalProfiles: [] } });
    press(byLabel(renderer, 'Advanced Configuration'));

    addVariable(renderer, 'API_KEY', 'abc');
    expect(buttonByText(renderer, 'Save as profile')).toBeDefined();
  });

  it('includes the session-owned selected profile in resource counts', () => {
    const renderer = mount({ selectedProfileId: 'backend' });
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(texts(renderer)).toContain('3 vars · 1 setup cmd');
  });

  it('saves the manual config as one atomic create and selects the new profile', async () => {
    const mocks = mutations();
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'My Setup');
    act(() => {
      (renderer.root.findByType('Switch' as never).props.onValueChange as (value: boolean) => void)(
        true
      );
    });
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    // The vars, the commands and the default flag travel inside the create, so
    // the server commits them together: nothing is left for a follow-up write.
    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      ...MANUAL_PAYLOAD,
      setAsDefault: true,
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onSelectProfile).toHaveBeenCalledWith('new-1');
    // The profile carries the draft now, and the server appends a profile's
    // setup commands to the inline ones, so a kept draft would run them twice.
    expect(texts(renderer)).not.toContain('API_KEY');
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
    expect(texts(renderer)).toContain('1 var · 1 setup cmd');
  });

  it('offers a saved profile only under the account that saved it', async () => {
    const mocks = mutations();
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, organizationId: 'org-1', onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'My Setup');

    // The row shows in the account it was saved in, before the invalidated
    // refetch lands, and the save picks it for this session.
    expect(onSelectProfile).toHaveBeenCalledWith('new-1');
    expect(texts(renderer)).toContain('1 var · 1 setup cmd');

    // The panel stays mounted while the account moves to another organization,
    // whose list holds no profile at all.
    listMock.useAgentProfileList.mockImplementation((scope?: string) =>
      listState(scope === 'org-1' ? {} : { personalProfiles: [] })
    );
    rerenderWithScope(renderer, 'org-2', onSelectProfile);

    // Org-2 counts only its own rows.
    expect(texts(renderer)).not.toContain('1 var · 1 setup cmd');
  });

  it('finishes a save only in the account it started in', async () => {
    const mocks = mutations();
    const write = Promise.withResolvers<{ id: string }>();
    mocks.create.mutateAsync.mockReturnValue(write.promise);
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, organizationId: 'org-1', onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'My Setup');
    // Start the write without waiting for its answer.
    act(() => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    });

    listMock.useAgentProfileList.mockImplementation(() => listState({ personalProfiles: [] }));
    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    await act(async () => {
      write.resolve({ id: 'new-1' });
      await Promise.resolve();
    });

    // The profile belongs to org-1, so the account on screen neither offers nor
    // picks it.
    expect(onSelectProfile).not.toHaveBeenCalled();
    // The form keeps the configuration it holds.
    expect(texts(renderer)).toContain('API_KEY');
    // The draft's counts and the saved row's counts are the same pair, so
    // dropping the draft's command makes the two distinguishable: the account
    // on screen counts only what its draft holds, while a row published into it
    // would add its own var and its saved command on top.
    typeInto(renderer, 'Command 1', '');
    expect(texts(renderer)).toContain('1 var');
    expect(texts(renderer)).not.toContain('2 vars');
    // The save did complete, so the person still sees the confirmation.
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('re-offers no saved row after returning to the account it was saved in', async () => {
    const mocks = mutations();
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    // Neither account's list holds a row, so the only thing an account could
    // offer here is the record this panel wrote there.
    const renderer = mount({
      mocks,
      organizationId: 'org-1',
      list: { personalProfiles: [] },
      onSelectProfile,
    });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'My Setup');

    // The saved row publishes in the account that saved it.
    expect(onSelectProfile).toHaveBeenCalledWith('new-1');
    expect(texts(renderer)).toContain('1 var · 1 setup cmd');

    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    expect(texts(renderer)).not.toContain('1 var · 1 setup cmd');

    rerenderWithScope(renderer, 'org-1', onSelectProfile);

    // The record described that visit only: the profile may have been deleted
    // since, so a return to the account starts from the account's own list.
    expect(texts(renderer)).not.toContain('1 var · 1 setup cmd');
    expect(onSelectProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps the account on screen's own saved row when a later settlement belongs to another account", async () => {
    const mocks = mutations();
    const firstWrite = Promise.withResolvers<{ id: string }>();
    mocks.create.mutateAsync
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue({ id: 'org2-1' });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({
      mocks,
      organizationId: 'org-1',
      list: { personalProfiles: [] },
      onSelectProfile,
    });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'My Setup');
    // Start the write without waiting for its answer.
    act(() => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    });

    // The account moves while the write is still unanswered.
    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    // Org-2 saves a profile of its own, with a draft that counts differently so
    // the two rows are distinguishable: its save settles first.
    addVariable(renderer, 'SECOND', 'xyz');
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'Second Setup');

    expect(onSelectProfile).toHaveBeenCalledWith('org2-1');
    expect(texts(renderer)).toContain('2 vars · 1 setup cmd');

    // Org-1's write settles now, into an account the panel has left: it
    // publishes nothing here, so org-2's row and counts stay on screen.
    await act(async () => {
      firstWrite.resolve({ id: 'new-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(texts(renderer)).toContain('2 vars · 1 setup cmd');
    expect(texts(renderer)).not.toContain('1 var · 1 setup cmd');
    expect(onSelectProfile).not.toHaveBeenCalledWith('new-1');
    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    // The write did complete in the account that received it, so both saves are
    // reported.
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("keeps the account on screen's saved row when a later lost attempt belongs to another account", async () => {
    const mocks = mutations();
    const firstWrite = Promise.withResolvers<{ id: string }>();
    mocks.create.mutateAsync
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue({ id: 'org2-1' });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({
      mocks,
      organizationId: 'org-1',
      list: { personalProfiles: [] },
      onSelectProfile,
    });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'My Setup');
    // Start the write without waiting for its answer.
    act(() => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    });

    // The account moves while the write is still unanswered, and org-2 saves a
    // profile of its own from a draft that counts differently, so the two rows
    // can be told apart.
    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    addVariable(renderer, 'SECOND', 'xyz');
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'Second Setup');

    expect(onSelectProfile).toHaveBeenCalledWith('org2-1');
    expect(texts(renderer)).toContain('2 vars · 1 setup cmd');

    // Org-1's write now fails with a transport wrapper and no server sentence,
    // so its outcome is unknown: the attempt is recorded against org-1, the
    // account it was made in, and not against the account on screen.
    await act(async () => {
      firstWrite.reject(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Org-2's row and counts are still the ones on screen, and org-1's row never
    // appears in it.
    expect(texts(renderer)).toContain('2 vars · 1 setup cmd');
    expect(texts(renderer)).not.toContain('1 var · 1 setup cmd');
    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    // Only org-2's save completed, so only it is confirmed.
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('recovers an unanswered attempt after visiting another account and returning', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The first attempt's response never arrives: a transport wrapper named like
    // a client error, carrying no envelope, so the outcome is unknown. The retry
    // collides on the name the unanswered write had already stored.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'organization',
    };
    // Org-1's combined read holds the row the unanswered write stored.
    const refetch = vi
      .fn()
      .mockResolvedValue({ data: { orgProfiles: [created], personalProfiles: [] } });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, organizationId: 'org-1', list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    // The write is left unanswered, then the panel visits another account and
    // comes back before the person retries.
    await submitSave(renderer, 'prod');
    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    rerenderWithScope(renderer, 'org-1', onSelectProfile);

    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // The attempt was made in org-1, so returning to org-1 keeps it, and the row
    // absent from that account's list before the attempt is its own commit.
    expect(refetch).toHaveBeenCalled();
    expect(onSelectProfile).toHaveBeenCalledWith('prod-1');
    expect(toast.success).toHaveBeenCalledTimes(1);
    // The save completed on the recovered row: the sheet closed, the draft it
    // carried cleared and the duplicate sentence never reached the person.
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(0);
    expect(texts(renderer)).not.toContain('API_KEY');
    expect(texts(renderer)).not.toContain(refusal);
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
  });

  it('reports a name that is taken once the unanswered write has completed', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    // The first attempt's response never arrives; the retry collides on the row
    // that write stored, and the third attempt collides on the same row after
    // the save has already completed.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValue(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, created] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'prod');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    // The retry converged on the row the unanswered write stored.
    expect(onSelectProfile).toHaveBeenCalledWith('prod-1');
    expect(toast.success).toHaveBeenCalledTimes(1);

    // The completed save retires the record of that write, so a later collision
    // on the same name is a name that is taken, not another completion. The
    // panel is already expanded, so the draft is filled directly.
    addVariable(renderer, 'API_KEY', 'abc');
    press(buttonByText(renderer, 'Add command'));
    typeInto(renderer, 'Command 1', 'pnpm install');
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'prod');

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(3);
    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(saveSheetMessage(renderer)).toBe(refusal);
  });

  it("resolves a retry against this account's own record", async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    const firstWrite = Promise.withResolvers<{ id: string }>();
    // Each account keeps its own save record.
    mocks.create.mutateAsync
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce({ id: 'org2-1' })
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'organization',
    };
    const refetch = vi
      .fn()
      .mockResolvedValue({ data: { orgProfiles: [created], personalProfiles: [] } });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({
      mocks,
      organizationId: 'org-1',
      list: { personalProfiles: [], refetch },
      onSelectProfile,
    });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'prod');
    // Start the write without waiting for its answer.
    act(() => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    });

    // The panel moves to org-2 while that save is still open.
    rerenderWithScope(renderer, 'org-2', onSelectProfile);

    // A transport wrapper carries no outcome, so the attempt belongs to the
    // account the save was made in.
    await act(async () => {
      firstWrite.reject(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Org-2 then completes a save of its own.
    addVariable(renderer, 'SECOND', 'xyz');
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'Second Setup');
    expect(onSelectProfile).toHaveBeenCalledWith('org2-1');

    // Back in org-1, the retry resolves against org-1's own record.
    rerenderWithScope(renderer, 'org-1', onSelectProfile);
    addVariable(renderer, 'API_KEY', 'abc');
    press(buttonByText(renderer, 'Add command'));
    typeInto(renderer, 'Command 1', 'pnpm install');
    press(buttonByText(renderer, 'Save as profile'));
    await submitSave(renderer, 'prod');

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(3);
    expect(refetch).toHaveBeenCalled();
    expect(onSelectProfile).toHaveBeenCalledWith('prod-1');
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(0);
  });

  it('keeps the save sheet open and the typed name when the save fails', async () => {
    const mocks = mutations();
    mocks.create.mutateAsync.mockRejectedValue(new Error('nope'));

    const renderer = mount({ mocks });
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'Broken');

    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(field(renderer, 'Profile name')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    // A bare `Error` carries no tRPC payload, so the panel cannot know whether
    // the write landed and the sheet states the neutral line, not a server one.
    expect(saveSheetMessage(renderer)).toBe(i18n.t('profiles.saveFailed'));
    // The sheet is this flow's only failure surface: no toast repeats the line.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('asks the mutation hook for a quiet create, so the sheet alone states a refusal', () => {
    const renderer = mount({ organizationId: 'org-1' });
    expect(listMock.useAgentProfileMutations).toHaveBeenLastCalledWith('org-1', {
      quietCreateErrorToast: true,
    });
    renderer.unmount();
  });

  it('a rejection that carries no Error and no server sentence states the sheet line only', async () => {
    const mocks = mutations();
    // The fallback the panel used to toast fired on a rejection that is not an
    // Error, so this case fails if the panel takes a failure surface of its own.
    mocks.create.mutateAsync.mockRejectedValue('nope');
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith(MANUAL_PAYLOAD);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(saveSheetMessage(renderer)).toBe(i18n.t('profiles.saveFailed'));
  });

  it('a refusal with only a whitespace message states the sheet line only', async () => {
    const mocks = mutations();
    // The panel's old fallback fired on a message that trims to nothing, so this
    // case fails if the panel takes a failure surface of its own.
    mocks.create.mutateAsync.mockRejectedValue(new Error('   '));
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    expect(toast.error).not.toHaveBeenCalled();
    expect(saveSheetMessage(renderer)).toBe(i18n.t('profiles.saveFailed'));
  });

  it('a refused save leaves the draft intact and writes nothing else', async () => {
    const mocks = mutations();
    // The production shape of the client deadline: named like a tRPC client
    // error but payload-less, so its text is engineering detail, not a refusal.
    mocks.create.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Request timed out after 15000ms'), { name: 'TRPCClientError' })
    );
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    // The whole config travels in the refused call, so a partial profile was
    // never possible and no follow-up write can be left to run.
    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith(MANUAL_PAYLOAD);
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSelectProfile).not.toHaveBeenCalled();
    // The draft is still the person's: the save did not clear it, and Save is
    // still offered.
    expect(texts(renderer)).toContain('API_KEY');
    expect(buttonByText(renderer, 'Save as profile')).toBeDefined();
    // A transport failure is not a server answer, so the line stays neutral.
    const message = saveSheetMessage(renderer);
    expect(message).toBe(i18n.t('profiles.saveFailed'));
    expect(message).not.toContain('Request timed out after 15000ms');
  });

  it('a lost connection reaches the person as the neutral line, not the transport text', async () => {
    const mocks = mutations();
    mocks.create.mutateAsync.mockRejectedValue(
      Object.assign(new Error('fetch failed: Unable to resolve host'), {
        name: 'TRPCClientError',
      })
    );
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith(MANUAL_PAYLOAD);
    expect(toast.success).not.toHaveBeenCalled();
    const message = saveSheetMessage(renderer);
    expect(message).toBe(i18n.t('profiles.saveFailed'));
    expect(message).not.toContain('Unable to resolve host');
  });

  it('shows the server sentence when the save is refused with a tRPC conflict', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The shape measured against the local server: the formatted payload holds
    // the code, status, path and zod error, and the server's sentence is the
    // error's own message. A transport failure has the name but no payload, and
    // the case above covers that.
    mocks.create.mutateAsync.mockRejectedValue(
      Object.assign(new Error(refusal), {
        name: 'TRPCClientError',
        data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
      })
    );
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith(MANUAL_PAYLOAD);
    // The server answered, so its own sentence is the line the sheet shows.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    // The sheet stayed open on the same typed name, so it can be corrected.
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(1);
    expect(renderer.root.findByType('SheetHeader' as never).props.doneDisabled).toBe(false);
  });

  it('states the neutral line when the save fails unexpectedly', async () => {
    const mocks = mutations();
    // An unexpected failure carries diagnostic text and a payload with the
    // code, status, path and stack. The sheet states its own line and offers
    // the retry, because the server wrote no sentence for a person.
    mocks.create.mutateAsync.mockRejectedValue(
      Object.assign(new Error('probe diagnostic text'), {
        name: 'TRPCClientError',
        data: {
          code: 'INTERNAL_SERVER_ERROR',
          httpStatus: 500,
          path: 'agentProfiles.create',
          stack: 'probe stack',
        },
      })
    );
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');

    expect(mocks.create.mutateAsync).toHaveBeenCalledExactlyOnceWith(MANUAL_PAYLOAD);
    expect(toast.success).not.toHaveBeenCalled();
    const message = saveSheetMessage(renderer);
    expect(message).toBe(i18n.t('profiles.saveFailed'));
    expect(message).not.toContain('probe diagnostic text');
  });

  it('a retry after a refusal reissues the same complete payload once more', async () => {
    const mocks = mutations();
    mocks.create.mutateAsync.mockRejectedValueOnce(new Error('Took too long'));
    const renderer = mount({ mocks });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'My Setup');
    // The sheet stays open with the typed name, so the retry is another submit.
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // Both attempts carry every var, every command and the same name: the
    // retry cannot create a second profile holding only part of the config.
    expect(mocks.create.mutateAsync.mock.calls[0]).toEqual([MANUAL_PAYLOAD]);
    expect(mocks.create.mutateAsync.mock.calls[1]).toEqual(mocks.create.mutateAsync.mock.calls[0]);
  });

  it('reads a recorded save only in the account that recorded it', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    const lost = Promise.withResolvers<never>();
    // The first attempt never answers; its rejection arrives after the move.
    mocks.create.mutateAsync.mockReturnValueOnce(lost.promise).mockRejectedValueOnce(
      Object.assign(new Error(refusal), {
        name: 'TRPCClientError',
        data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
      })
    );
    const other: ProfileSelectorProfile = {
      id: 'org2-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'organization',
    };
    // Org-2's list holds a row of that name.
    const refetch = vi
      .fn()
      .mockResolvedValue({ data: { orgProfiles: [other], personalProfiles: [] } });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, organizationId: 'org-1', list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));
    typeInto(renderer, 'Profile name', 'prod');
    act(() => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
    });

    // The account moves while the write is still unanswered.
    rerenderWithScope(renderer, 'org-2', onSelectProfile);
    await act(async () => {
      lost.reject(Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The retry in org-2 collides on the name.
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // The record belongs to org-1, so org-2's rows complete no save here.
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(saveSheetMessage(renderer)).toBe(refusal);
  });

  it('converges a retry that collides on the name onto the lost attempt that created it', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The first attempt's response never arrives: a transport wrapper named like
    // a client error, carrying no envelope, so the outcome is unknown.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    // The list the retry reads holds the profile the unanswered write stored.
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, created] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // The row was absent before the attempt, so it is that attempt's own commit.
    expect(refetch).toHaveBeenCalled();
    expect(onSelectProfile).toHaveBeenCalledWith('prod-1');
    expect(toast.success).toHaveBeenCalledTimes(1);
    // The save completed, so the sheet closed, the draft it carried cleared and
    // the duplicate sentence never reached the person.
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(0);
    expect(texts(renderer)).not.toContain('API_KEY');
    expect(texts(renderer)).not.toContain(refusal);
    expect(buttonByText(renderer, 'Save as profile')).toBeUndefined();
  });

  it('refuses a colliding retry whose draft no longer carries the lost attempt config', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The first attempt's response never arrives, so its outcome is unknown.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    // The unanswered write stored the profile with the variable it submitted;
    // the person then edits that variable before retrying the same name.
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, created] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    // The person closes the sheet and changes the draft value from `abc` to
    // `xyz`, then reopens it under the same name.
    const sheet = renderer.root.findAll(node => node.type === SaveProfileSheet)[0];
    if (!sheet) {
      throw new TypeError('the sheet was not mounted');
    }
    invokeHandler(sheet.props.onClose);
    press(byLabel(renderer, 'API_KEY'));
    typeInto(renderer, 'Value', 'xyz');
    press(buttonByText(renderer, 'Save'));
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // The retry really carries the edited value, so the content is what differs.
    expect(mocks.create.mutateAsync.mock.calls[1]).toEqual([
      {
        ...MANUAL_PAYLOAD,
        name: 'prod',
        vars: [{ key: 'API_KEY', value: 'xyz', isSecret: false }],
      },
    ]);
    // The row carries the identity of the lost attempt but not its content, so
    // adopting it would confirm a save whose variables never reached the server.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    expect(texts(renderer)).toContain('API_KEY');
    expect(texts(renderer)).toContain('xyz');
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses a colliding retry that only adds a description', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The first attempt's response never arrives, so its outcome is unknown; the
    // retry then collides on the name.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    // The unanswered write stored the profile with the counts it submitted, and
    // the create stores a description, so a description typed after the loss is
    // content the refetched row does not hold.
    const created: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, created] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    // Only the description changes before the retry: the name, the variable and
    // the command are the ones the lost attempt sent.
    typeInto(renderer, 'Profile description', 'nightly build');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    // The retry really carries the new description, so the description is what
    // differs between the two attempts.
    expect(mocks.create.mutateAsync.mock.calls[1]).toEqual([
      { ...MANUAL_PAYLOAD, name: 'prod', description: 'nightly build' },
    ]);
    // The row was this flow's commit, but the description the person typed was in
    // neither attempt, so adopting the row would confirm a save whose description
    // never reached the server.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    expect(texts(renderer)).toContain('API_KEY');
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses to adopt a refetched row whose counts no longer match the attempt', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The retry sends exactly what the lost attempt sent, so only the row itself
    // can disagree.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    // The row carries the name and an id the panel did not know, but a second
    // variable was added to it after the lost write.
    const edited: ProfileSelectorProfile = {
      id: 'prod-1',
      name: 'prod',
      varCount: 2,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, edited] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.create.mutateAsync.mock.calls[1]).toEqual(mocks.create.mutateAsync.mock.calls[0]);
    // The row holds more than this flow submitted, so it is not the save's own
    // record and the draft stays with the person.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    expect(texts(renderer)).toContain('API_KEY');
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses to adopt a refetched row whose stored description no longer matches', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    // The retry sends exactly what the lost attempt sent, so only the row's own
    // stored description can disagree with it.
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    // The row carries the name, an id the panel did not know and the submitted
    // counts, but its description was changed after the lost write.
    // The list row carries the stored description the panel reads, which the
    // selector profile it builds does not.
    const edited: ProfileSelectorProfile & { description: string | null } = {
      id: 'prod-1',
      name: 'prod',
      description: 'changed elsewhere',
      varCount: 1,
      commandCount: 1,
      isDefault: false,
      ownerType: 'user',
    };
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, edited] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ mocks, list: { refetch }, onSelectProfile });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    // The row no longer holds the description this flow submitted, so it is not
    // the save's own record and the draft stays with the person.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    expect(texts(renderer)).toContain('API_KEY');
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('states the duplicate sentence when the name was taken before any attempt', async () => {
    const mocks = mutations();
    const refusal = 'A profile with this name already exists';
    mocks.create.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('Network request failed'), { name: 'TRPCClientError' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(refusal), {
          name: 'TRPCClientError',
          data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
        })
      );
    const taken: ProfileSelectorProfile = {
      id: 'prod-taken',
      name: 'prod',
      varCount: 0,
      commandCount: 0,
      isDefault: false,
      ownerType: 'user',
    };
    // The only `prod` row the retry finds is one the panel already had, so the
    // collision belongs to somebody else's profile, not to a lost commit.
    const refetch = vi.fn().mockResolvedValue({ data: [BACKEND, taken] });
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({
      mocks,
      list: { personalProfiles: [BACKEND, taken], refetch },
      onSelectProfile,
    });
    fillManualConfig(renderer);
    press(buttonByText(renderer, 'Save as profile'));

    await submitSave(renderer, 'prod');
    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    // The draft is only cleared on a match: an unrelated profile must never take
    // the person's configuration, so the sheet keeps both the sentence and the
    // rows they entered.
    expect(saveSheetMessage(renderer)).toBe(refusal);
    expect(texts(renderer)).toContain('API_KEY');
    expect(onSelectProfile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a late onClose from a closed save sheet leaves the reopened sheet open', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');

    press(buttonByText(renderer, 'Save as profile'));
    const firstSheet = renderer.root.findAll(node => node.type === SaveProfileSheet)[0];
    if (!firstSheet) {
      throw new TypeError('the first sheet was not mounted');
    }
    const firstClose: unknown = firstSheet.props.onClose;

    // The person dismisses it, then opens it again.
    invokeHandler(firstClose);
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(0);
    press(buttonByText(renderer, 'Save as profile'));
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(1);

    // A settlement from the closed sheet arrives late: it must not close the
    // sheet that replaced it.
    invokeHandler(firstClose);
    expect(renderer.root.findAll(node => node.type === SaveProfileSheet)).toHaveLength(1);
  });
});
