/* eslint-disable max-lines -- one mounted case per panel state: the controlled selector, both manual editors, the save flow, and the retryable failure */
import { createElement, type ReactNode, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AdvancedConfigPanel } from './advanced-config-panel';
import { type ProfileSelectorProfile } from './profile-selector-model';

const push = vi.fn<(href: string) => void>();
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner-native', () => ({ toast }));

const listMock = vi.hoisted(() => ({
  useAgentProfileList: vi.fn(),
  useAgentProfileMutations: vi.fn(),
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => listMock);

vi.mock('react-native', () => ({
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

type Mutations = {
  create: { mutateAsync: ReturnType<typeof vi.fn> };
  setVar: { mutateAsync: ReturnType<typeof vi.fn> };
  setCommands: { mutateAsync: ReturnType<typeof vi.fn> };
  setAsDefault: { mutateAsync: ReturnType<typeof vi.fn> };
};

function mutations(): Mutations {
  return {
    create: { mutateAsync: vi.fn().mockResolvedValue({ id: 'new-1' }) },
    setVar: { mutateAsync: vi.fn().mockResolvedValue({}) },
    setCommands: { mutateAsync: vi.fn().mockResolvedValue({}) },
    setAsDefault: { mutateAsync: vi.fn().mockResolvedValue({}) },
  };
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
 * The panel's profile pick is controlled by the session, so the harness mirrors
 * the real parent: it owns `selectedProfileId` and reports each pick both to
 * the spy and to its own state, the way the new-session body does.
 */
function ControlledPanel({
  organizationId,
  initialSelectedProfileId,
  onSelectProfile,
}: {
  organizationId?: string;
  initialSelectedProfileId?: string | null;
  onSelectProfile?: (id: string | null) => void;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    initialSelectedProfileId ?? null
  );
  return createElement(AdvancedConfigPanel, {
    organizationId,
    selectedProfileId,
    onSelectProfile: id => {
      onSelectProfile?.(id);
      setSelectedProfileId(id);
    },
  });
}

function mount(
  options: {
    list?: Partial<ListState>;
    mocks?: Mutations;
    organizationId?: string;
    selectedProfileId?: string | null;
    onSelectProfile?: (id: string | null) => void;
  } = {}
) {
  listMock.useAgentProfileList.mockReturnValue(listState(options.list));
  listMock.useAgentProfileMutations.mockReturnValue(options.mocks ?? mutations());
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ControlledPanel, {
        organizationId: options.organizationId,
        initialSelectedProfileId: options.selectedProfileId,
        onSelectProfile: options.onSelectProfile,
      })
    );
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the panel did not render');
  }
  return renderer;
}

function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAll(node => node.props.accessibilityLabel === label)
    .find(node => typeof node.props.onPress === 'function');
}

function radios(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => node.props.accessibilityRole === 'radio');
}

function radio(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return radios(renderer).find(node => node.props.accessibilityLabel === label);
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

/** First call position of a mock, for ordering assertions. */
function callOrder(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.invocationCallOrder[0] ?? 0;
}

function addVariable(renderer: TestRenderer.ReactTestRenderer, key: string, value: string) {
  press(buttonByText(renderer, 'Add variable'));
  typeInto(renderer, 'Key', key);
  typeInto(renderer, 'Value', value);
  press(buttonByText(renderer, 'Save'));
}

beforeEach(() => {
  push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('AdvancedConfigPanel', () => {
  it('is collapsed by default and reserves only the disclosure row', () => {
    const renderer = mount();

    const disclosure = byLabel(renderer, 'Advanced Configuration');
    expect(disclosure?.props.accessibilityState).toMatchObject({ expanded: false });
    expect(byLabel(renderer, 'Pick a profile')).toBeUndefined();
    expect(texts(renderer)).not.toContain('Environment variables');
    expect(buttonByText(renderer, 'Save as Profile')).toBeUndefined();
  });

  it('expands to the selector, both manual editors and the summary', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(byLabel(renderer, 'Pick a profile')).toBeDefined();
    expect(texts(renderer)).toContain('Environment variables');
    expect(texts(renderer)).toContain('Setup commands');
    // No manual config yet, so no Save as Profile.
    expect(buttonByText(renderer, 'Save as Profile')).toBeUndefined();
  });

  it('only offers Save as Profile for commands that will be persisted', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    press(buttonByText(renderer, 'Add command'));
    expect(buttonByText(renderer, 'Save as Profile')).toBeUndefined();
    typeInto(renderer, 'Command', '   ');
    expect(buttonByText(renderer, 'Save as Profile')).toBeUndefined();
    typeInto(renderer, 'Command', 'pnpm install');
    expect(buttonByText(renderer, 'Save as Profile')).toBeDefined();
    typeInto(renderer, 'Command', '');
    expect(buttonByText(renderer, 'Save as Profile')).toBeUndefined();
  });

  it('offers Save as Profile once a manual variable exists', () => {
    const renderer = mount();
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');

    expect(buttonByText(renderer, 'Save as Profile')).toBeDefined();
    expect(texts(renderer)).toContain('1 environment variables · 0 setup commands');
  });

  it('keeps No profile and manual config working with no profiles at all', () => {
    const renderer = mount({ list: { personalProfiles: [] } });
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(texts(renderer)).toContain('No profile');
    addVariable(renderer, 'API_KEY', 'abc');
    expect(buttonByText(renderer, 'Save as Profile')).toBeDefined();
  });

  it('shows the retryable failure and refetches', () => {
    const refetch = vi.fn();
    const renderer = mount({ list: { isError: true, refetch } });
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(texts(renderer)).toContain('Failed to load profiles');
    press(byLabel(renderer, 'Retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the session-owned selectedProfileId in the closed row', () => {
    const renderer = mount({ selectedProfileId: 'backend' });
    press(byLabel(renderer, 'Advanced Configuration'));

    expect(texts(renderer)).toContain('Backend');
    expect(texts(renderer)).toContain('3 environment variables · 1 setup commands');
  });

  it('reports a pick from the sheet through onSelectProfile and shows it', () => {
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ onSelectProfile });
    press(byLabel(renderer, 'Advanced Configuration'));
    press(byLabel(renderer, 'Pick a profile'));

    expect(radio(renderer, 'No profile')?.props.accessibilityState).toMatchObject({
      checked: true,
    });
    press(radio(renderer, 'Backend'));

    expect(onSelectProfile).toHaveBeenCalledWith('backend');
    expect(texts(renderer)).toContain('Backend');
    expect(texts(renderer)).toContain('3 environment variables · 1 setup commands');
  });

  it('reports No profile through onSelectProfile(null) and clears the row', () => {
    const onSelectProfile = vi.fn<(id: string | null) => void>();
    const renderer = mount({ selectedProfileId: 'backend', onSelectProfile });
    press(byLabel(renderer, 'Advanced Configuration'));
    press(byLabel(renderer, 'Pick a profile'));

    press(radio(renderer, 'No profile'));

    expect(onSelectProfile).toHaveBeenCalledWith(null);
    expect(texts(renderer)).toContain('No profile');
  });

  it('saves the manual config in the web order and shows the new profile', async () => {
    const mocks = mutations();
    const renderer = mount({ mocks });
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');
    // A setup command.
    press(buttonByText(renderer, 'Add command'));
    typeInto(renderer, 'Command', 'pnpm install');
    press(buttonByText(renderer, 'Save as Profile'));

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

    expect(callOrder(mocks.create.mutateAsync)).toBeLessThan(callOrder(mocks.setVar.mutateAsync));
    expect(callOrder(mocks.setVar.mutateAsync)).toBeLessThan(
      callOrder(mocks.setCommands.mutateAsync)
    );
    expect(callOrder(mocks.setCommands.mutateAsync)).toBeLessThan(
      callOrder(mocks.setAsDefault.mutateAsync)
    );
    expect(mocks.create.mutateAsync).toHaveBeenCalledWith({
      name: 'My Setup',
      description: undefined,
    });
    expect(mocks.setVar.mutateAsync).toHaveBeenCalledWith({
      profileId: 'new-1',
      key: 'API_KEY',
      value: 'abc',
      isSecret: false,
    });
    expect(mocks.setCommands.mutateAsync).toHaveBeenCalledWith({
      profileId: 'new-1',
      commands: ['pnpm install'],
    });
    expect(mocks.setAsDefault.mutateAsync).toHaveBeenCalledWith({ profileId: 'new-1' });
    expect(toast.success).toHaveBeenCalledTimes(1);
    // The saved profile appears in the selector immediately.
    expect(texts(renderer)).toContain('My Setup');
  });

  it('keeps the save sheet open and the typed name when the save fails', async () => {
    const mocks = mutations();
    mocks.create.mutateAsync.mockRejectedValue(new Error('nope'));

    const renderer = mount({ mocks });
    press(byLabel(renderer, 'Advanced Configuration'));
    addVariable(renderer, 'API_KEY', 'abc');
    press(buttonByText(renderer, 'Save as Profile'));
    typeInto(renderer, 'Profile name', 'Broken');

    await act(async () => {
      (renderer.root.findByType('SheetHeader' as never).props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(field(renderer, 'Profile name')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
