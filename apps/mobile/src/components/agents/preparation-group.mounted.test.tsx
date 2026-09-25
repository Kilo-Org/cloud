import '@/i18n';
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { humanizePreparationStepLabel, PreparationGroup } from './preparation-group';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Terminal: 'Terminal',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#999999',
    good: '#3FA34D',
    destructive: '#BE4E3F',
  }),
}));
// The real block pulls in react-native-gesture-handler's Flow source, which the
// node project cannot parse; the phase rows under test carry no output tail.
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));

function phaseStep(overrides: Partial<PreparationStepSnapshot> = {}): PreparationStepSnapshot {
  return {
    id: 'step-1',
    key: 'workspace_setup',
    kind: 'phase',
    label: 'workspace setup',
    status: 'running',
    startedAt: 1,
    revision: 1,
    ...overrides,
  };
}

function attemptWithStep(step: PreparationStepSnapshot): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'msg-1',
    status: 'running',
    startedAt: 1,
    revision: 1,
    steps: [step],
  };
}

async function mountGroup(attempt: PreparationAttempt): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(PreparationGroup, { attempt }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function textValues(root: TestRenderer.ReactTestInstance): unknown[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => node.props.children);
}

describe('humanizePreparationStepLabel', () => {
  it('title-cases a raw server phase label', () => {
    expect(humanizePreparationStepLabel('workspace setup')).toBe('Workspace setup');
    expect(humanizePreparationStepLabel('disk_check')).toBe('Disk check');
  });

  it('leaves an already title-cased label unchanged', () => {
    expect(humanizePreparationStepLabel('Setup command 1')).toBe('Setup command 1');
  });
});

describe('PreparationGroup phase label', () => {
  it('renders a title-cased phase label instead of the raw server string', async () => {
    const renderer = await mountGroup(attemptWithStep(phaseStep()));

    const texts = textValues(renderer.root);
    expect(texts).toContain('Workspace setup');
    expect(texts).not.toContain('workspace setup');

    act(() => {
      renderer.unmount();
    });
  });
});

const INCOMPLETE_TEXT =
  'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts';

function incompleteStep(overrides: Partial<PreparationStepSnapshot>): PreparationStepSnapshot {
  return {
    id: 'step-1',
    key: 'workspace_setup',
    kind: 'phase',
    label: 'workspace setup',
    status: 'completed',
    startedAt: 1000,
    revision: 1,
    ...overrides,
  };
}

function restoreAttempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'completed',
    startedAt: 1000,
    revision: 1,
    steps: [],
    ...overrides,
  };
}

const INCOMPLETE_ATTEMPT = restoreAttempt({
  status: 'completed',
  completedAt: 13_400,
  steps: [
    incompleteStep({ id: 'restore', key: 'workspace_restore', status: 'completed' }),
    incompleteStep({
      id: 'incomplete',
      key: 'restore_incomplete',
      label: 'Session restore incomplete',
      status: 'failed',
      safeError: INCOMPLETE_TEXT,
    }),
  ],
});

type Mount = Awaited<ReturnType<typeof renderWithProviders>>;

async function mount(candidate: PreparationAttempt) {
  const mounted: Mount = await renderWithProviders(
    createElement(PreparationGroup, { attempt: candidate })
  );
  const group = () => {
    const node = mounted.renderer.root.findAllByType('Pressable')[0];
    if (!node) {
      throw new Error('PreparationGroup pressable not found');
    }
    return node;
  };
  const renderedTextValues = () =>
    mounted.renderer.root
      .findAllByType('Text')
      .flatMap(node => node.children)
      .filter((child): child is string => typeof child === 'string');
  const updateGroup = (next: PreparationAttempt) => {
    act(() => {
      mounted.renderer.update(
        createElement(
          QueryClientProvider,
          { client: mounted.queryClient },
          createElement(PreparationGroup, { attempt: next })
        )
      );
    });
  };
  return { ...mounted, group, renderedTextValues, update: updateGroup };
}

describe('PreparationGroup incomplete restore', () => {
  it('shows the incomplete step text and icon instead of the green completion', async () => {
    const mounted = await mount(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityLabel).toBe(INCOMPLETE_TEXT);
    expect(mounted.group().findAllByType('Check')).toHaveLength(0);
    expect(mounted.group().findAllByType('AlertCircle')).toHaveLength(1);
    mounted.unmount();
  });

  it('expands the completed incomplete attempt so the detail is visible without a tap', async () => {
    const mounted = await mount(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: true });
    expect(mounted.renderedTextValues()).toContain(INCOMPLETE_TEXT);
    expect(mounted.renderedTextValues()).not.toContain('Preparation complete');
    mounted.unmount();
  });

  it('keeps a completed attempt without the step collapsed under the green completion', async () => {
    const mounted = await mount(
      restoreAttempt({ status: 'completed', completedAt: 13_400, steps: [incompleteStep({})] })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Preparation complete');
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: false });
    expect(mounted.renderer.root.findAllByType('Check')).toHaveLength(1);
    mounted.unmount();
  });

  it('keeps the running and failed titles and icons', async () => {
    const running = await mount(restoreAttempt({ status: 'running' }));
    expect(running.group().props.accessibilityLabel).toBe('Preparing environment');
    expect(running.renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    running.unmount();

    const failed = await mount(restoreAttempt({ status: 'failed', safeError: 'clone failed' }));
    expect(failed.group().props.accessibilityLabel).toBe('Preparation failed');
    expect(failed.renderer.root.findAllByType('Check')).toHaveLength(0);
    expect(failed.renderedTextValues()).toContain('clone failed');
    failed.unmount();
  });

  it('lets a terminal failure outrank the incomplete step', async () => {
    const mounted = await mount(
      restoreAttempt({
        status: 'failed',
        safeError: 'Setup command failed',
        steps: [
          incompleteStep({
            id: 'incomplete',
            key: 'restore_incomplete',
            label: 'Session restore incomplete',
            status: 'failed',
            safeError: INCOMPLETE_TEXT,
          }),
        ],
      })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Preparation failed');
    mounted.unmount();
  });

  it('opens the group when the incomplete step arrives after completion', async () => {
    const mounted = await mount(
      restoreAttempt({ status: 'completed', completedAt: 13_400, steps: [incompleteStep({})] })
    );
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: false });
    mounted.update(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityLabel).toBe(INCOMPLETE_TEXT);
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: true });
    mounted.unmount();
  });
});
