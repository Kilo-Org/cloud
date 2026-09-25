import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { PreparationGroup } from './preparation-group';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Terminal: 'Terminal',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#999999',
    good: '#3FA34D',
    destructive: '#BE4E3F',
  }),
}));
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));

const INCOMPLETE_TEXT =
  'Session restore incomplete: 2 of 5 files were not restored (binary file). Missing: a.ts, b.ts';

function step(overrides: Partial<PreparationStepSnapshot>): PreparationStepSnapshot {
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

function attempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
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

const INCOMPLETE_ATTEMPT = attempt({
  status: 'completed',
  completedAt: 13_400,
  steps: [
    step({ id: 'restore', key: 'workspace_restore', status: 'completed' }),
    step({
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
  const textValues = () =>
    mounted.renderer.root
      .findAllByType('Text')
      .flatMap(node => node.children)
      .filter((child): child is string => typeof child === 'string');
  const update = (next: PreparationAttempt) => {
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
  return { ...mounted, group, textValues, update };
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
    expect(mounted.textValues()).toContain(INCOMPLETE_TEXT);
    expect(mounted.textValues()).not.toContain('Preparation complete');
    mounted.unmount();
  });

  it('keeps a completed attempt without the step collapsed under the green completion', async () => {
    const mounted = await mount(
      attempt({ status: 'completed', completedAt: 13_400, steps: [step({})] })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Preparation complete');
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: false });
    expect(mounted.renderer.root.findAllByType('Check')).toHaveLength(1);
    mounted.unmount();
  });

  it('keeps the running and failed titles and icons', async () => {
    const running = await mount(attempt({ status: 'running' }));
    expect(running.group().props.accessibilityLabel).toBe('Preparing environment');
    expect(running.renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    running.unmount();

    const failed = await mount(attempt({ status: 'failed', safeError: 'clone failed' }));
    expect(failed.group().props.accessibilityLabel).toBe('Preparation failed');
    expect(failed.renderer.root.findAllByType('Check')).toHaveLength(0);
    expect(failed.textValues()).toContain('clone failed');
    failed.unmount();
  });

  it('lets a terminal failure outrank the incomplete step', async () => {
    const mounted = await mount(
      attempt({
        status: 'failed',
        safeError: 'Setup command failed',
        steps: [
          step({
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
      attempt({ status: 'completed', completedAt: 13_400, steps: [step({})] })
    );
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: false });
    mounted.update(INCOMPLETE_ATTEMPT);
    expect(mounted.group().props.accessibilityLabel).toBe(INCOMPLETE_TEXT);
    expect(mounted.group().props.accessibilityState).toEqual({ expanded: true });
    mounted.unmount();
  });
});
