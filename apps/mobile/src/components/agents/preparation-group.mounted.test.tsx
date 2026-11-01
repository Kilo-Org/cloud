import '@/i18n';
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { PreparationGroup } from './preparation-group';

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

describe('PreparationGroup phase label', () => {
  it('renders the catalog name for the phase key, not the server label', async () => {
    const renderer = await mountGroup(attemptWithStep(phaseStep()));

    const texts = textValues(renderer.root);
    expect(texts).toContain('Workspace setup');
    expect(texts).not.toContain('workspace setup');

    act(() => {
      renderer.unmount();
    });
  });

  it('renders a generic name for a phase key the app does not know', async () => {
    const renderer = await mountGroup(
      attemptWithStep(phaseStep({ key: 'a_new_phase', label: 'a new phase' }))
    );

    const texts = textValues(renderer.root);
    expect(texts).toContain('Environment setup');
    expect(texts).not.toContain('a new phase');

    act(() => {
      renderer.unmount();
    });
  });
});

const INCOMPLETE_TEXT =
  'Session restore incomplete: 2 of 5 files were not restored (the patch did not apply). Missing: a.ts, b.ts';

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
  it('shows the restore status and warning icon instead of the green completion', async () => {
    const mounted = await mount(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityLabel).toBe('Session restore incomplete');
    expect(mounted.group().findAllByType('Check')).toHaveLength(0);
    expect(mounted.group().findAllByType('AlertCircle')).toHaveLength(1);
    mounted.unmount();
  });

  it('keeps the report out of the one-line header and in the expanded body', async () => {
    const mounted = await mount(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: true });
    expect(mounted.renderedTextValues()).toContain(
      '2 of 5 files were not restored (the patch did not apply). Missing: a.ts, b.ts'
    );
    expect(mounted.renderedTextValues()).not.toContain(INCOMPLETE_TEXT);
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

  it('keeps the running title and keeps a stage-less cause in the body', async () => {
    const running = await mount(restoreAttempt({ status: 'running' }));
    expect(running.group().props.accessibilityLabel).toBe('Preparing environment');
    expect(running.renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    running.unmount();

    const failed = await mount(
      restoreAttempt({ status: 'failed', safeError: 'preparation_timeout' })
    );
    expect(failed.group().props.accessibilityLabel).toBe('Preparation failed');
    expect(failed.renderer.root.findAllByType('Check')).toHaveLength(0);
    expect(failed.renderedTextValues()).toContain('Environment preparation timed out');
    expect(failed.renderedTextValues()).not.toContain('preparation_timeout');
    failed.unmount();
  });

  it('names a failed attempt after the stage that failed', async () => {
    const mounted = await mount(
      restoreAttempt({
        status: 'failed',
        steps: [
          incompleteStep({ id: 'boot', key: 'sandbox_boot', status: 'failed' }),
          incompleteStep({
            id: 'boot-error',
            key: 'sandbox_boot',
            status: 'failed',
            safeError: 'sandbox_lost',
          }),
        ],
      })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Starting sandbox failed');
    expect(mounted.group().findAllByType('AlertCircle').length).toBeGreaterThan(0);
    mounted.unmount();
  });

  it('names a failed setup command by its number, not by the phase it belongs to', async () => {
    const mounted = await mount(
      restoreAttempt({
        status: 'failed',
        steps: [
          incompleteStep({
            id: 'commands',
            key: 'setup_commands',
            kind: 'setup_command',
            commandIndex: 1,
            commandCount: 3,
            status: 'failed',
          }),
        ],
      })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Setup command 2 of 3 failed');
    mounted.unmount();
  });

  it('gives a step that carries an error the warning icon rather than a status check', async () => {
    const mounted = await mount(
      restoreAttempt({
        status: 'failed',
        steps: [
          incompleteStep({ id: 'done', key: 'workspace_setup', status: 'completed' }),
          incompleteStep({
            id: 'lost',
            key: 'sandbox_boot',
            status: 'completed',
            safeError: 'sandbox_lost',
          }),
        ],
      })
    );
    const row = (label: string) =>
      mounted.renderer.root.findAll(
        node => (node.type as string) === 'Pressable' && node.props.accessibilityLabel === label
      )[0];
    expect(row('Workspace setup')?.findAllByType('Check')).toHaveLength(1);
    expect(row('Workspace setup')?.findAllByType('AlertCircle')).toHaveLength(0);
    expect(row('Starting sandbox')?.findAllByType('AlertCircle')).toHaveLength(1);
    expect(row('Starting sandbox')?.findAllByType('Check')).toHaveLength(0);
    mounted.unmount();
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
    expect(mounted.group().props.accessibilityLabel).toBe('Session restore incomplete');
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: true });
    mounted.unmount();
  });
});
