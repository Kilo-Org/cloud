import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { type RepositorySectionView } from '@/components/agents/new-session-repository-state';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

// ── React hooks ────────────────────────────────────────────────────
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
  };
});

// ── react-native ───────────────────────────────────────────────────
vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
}));

// ── sub-components ─────────────────────────────────────────────────
vi.mock('@/components/agents/new-session-configure-form', () => ({
  NewSessionConfigureForm: 'NewSessionConfigureForm',
}));

vi.mock('@/components/agents/run-target-step', () => ({
  RunTargetStep: 'RunTargetStep',
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));

// ── helpers ────────────────────────────────────────────────────────
type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findElementByType(node: Node, typeName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  if (type === typeName) {
    return node.props ?? {};
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, typeName);
    if (found) {
      return found;
    }
  }
  return null;
}

function countElementsByType(node: Node, typeName: string): number {
  if (node === null || typeof node !== 'object') {
    return 0;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  let count = type === typeName ? 1 : 0;
  for (const child of Array.isArray(children) ? children : [children]) {
    count += countElementsByType(child as Node, typeName);
  }
  return count;
}

const INSTANCE: InstancePickerInstance = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
};

function configureProps() {
  const voiceInputSettlerRef: React.RefObject<(() => Promise<boolean>) | null> = {
    current: null,
  };
  return {
    attachments: [] as never[],
    attachmentMax: 5,
    isCreating: false,
    isModelsError: false,
    isLoadingModels: false,
    mode: 'code' as AgentMode,
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [] as never[],
    onChangeText: vi.fn(),
    onModeChange: vi.fn(),
    onModelSelect: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRetryAttachment: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    shareId: undefined as string | undefined,
    voiceInputSettlerRef,
    showRunOnSelector: true,
    runOnInstance: null as InstancePickerInstance | null,
    instanceList: [] as InstancePickerInstance[],
    isLoadingInstances: false,
    onChangeRunOnInstance: vi.fn(),
    showInstanceDisconnectedNote: false,
    view: 'loading' as RepositorySectionView,
    isRetrying: false,
    onChangeRepo: vi.fn(),
    onOpenGitHubIntegration: vi.fn(),
    onRefreshRepos: vi.fn(),
    repositories: [] as { fullName: string; isPrivate: boolean }[],
    selectedRepo: '',
    isSpawningRemote: false,
    isStartDisabled: false,
    onStartSession: vi.fn(),
    initialPrompt: 'configure-default',
  };
}

describe('NewSessionFlowBody', () => {
  // ── Case 1: pending ──
  it('renders skeletons with no configure form or step when flowMode is pending', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'pending',
      step: 1,
      runOnInstance: null,
      instanceList: [],
      initialPrompt: '',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(0);
    expect(countElementsByType(element, 'RunTargetStep')).toBe(0);
    expect(countElementsByType(element, 'Skeleton')).toBeGreaterThan(0);
  });

  // ── Case 2: single, cloud ──
  it('renders one configure form with fixture values when single and cloud target', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'single',
      step: 1,
      runOnInstance: null,
      instanceList: [],
      initialPrompt: 'ignored in single',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(1);
    const form = findElementByType(element, 'NewSessionConfigureForm');
    expect(form).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(form!.showRunOnSelector).toBe(true);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.initialPrompt).toBe('configure-default');
  });

  // ── Case 3: single, remote ──
  it('renders one configure form when single and remote target', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'single',
      step: 1,
      runOnInstance: INSTANCE,
      instanceList: [INSTANCE],
      initialPrompt: '',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(1);
    const form = findElementByType(element, 'NewSessionConfigureForm');
    expect(form).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.showRunOnSelector).toBe(true);
  });

  // ── Case 4: steps, step 1 ──
  it('renders RunTargetStep and no configure form when step 1', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'steps',
      step: 1,
      runOnInstance: null,
      instanceList: [],
      initialPrompt: '',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(0);
    expect(countElementsByType(element, 'RunTargetStep')).toBe(1);
  });

  // ── Case 5: steps, step 2, cloud ──
  it('renders one configure form with overrides when step 2 cloud', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'steps',
      step: 2,
      runOnInstance: null,
      instanceList: [],
      initialPrompt: 'route-override',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(1);
    const form = findElementByType(element, 'NewSessionConfigureForm');
    expect(form).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.showRunOnSelector).toBe(false);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.initialPrompt).toBe('route-override');
  });

  // ── Case 6: steps, step 2, remote ──
  it('renders one configure form with same overrides when step 2 remote', async () => {
    const { NewSessionFlowBody } = await import('./new-session-flow-body');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionFlowBody({
      flowMode: 'steps',
      step: 2,
      runOnInstance: INSTANCE,
      instanceList: [INSTANCE],
      initialPrompt: 'route-override',
      onSelectTarget: vi.fn<(instance: InstancePickerInstance | null) => void>(),
      configureProps: configureProps(),
    }) as Node;

    expect(countElementsByType(element, 'NewSessionConfigureForm')).toBe(1);
    const form = findElementByType(element, 'NewSessionConfigureForm');
    expect(form).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.showRunOnSelector).toBe(false);
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion
    expect(form!.initialPrompt).toBe('route-override');
  });
});
