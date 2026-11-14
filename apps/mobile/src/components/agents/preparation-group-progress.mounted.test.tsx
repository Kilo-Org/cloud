import '@/i18n';
import { createElement } from 'react';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';
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
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));

function step(overrides: Partial<PreparationStepSnapshot>): PreparationStepSnapshot {
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

function attempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'running',
    startedAt: 1,
    revision: 1,
    steps: [],
    ...overrides,
  };
}

async function mount(candidate: PreparationAttempt) {
  const mounted = await renderWithProviders(
    createElement(PreparationGroup, { attempt: candidate })
  );
  const texts = () =>
    mounted.renderer.root
      .findAllByType('Text')
      .flatMap(node => node.children)
      .filter((child): child is string => typeof child === 'string');
  const pressable = (label: string) => {
    const node = mounted.renderer.root.findAll(
      candidateNode =>
        (candidateNode.type as string) === 'Pressable' &&
        candidateNode.props.accessibilityLabel === label
    )[0];
    if (node === undefined) {
      throw new Error(`pressable ${label} not found`);
    }
    return node;
  };
  const press = (label: string) => {
    const node = pressable(label);
    act(() => {
      (node.props.onPress as () => void)();
    });
  };
  return { ...mounted, texts, press };
}

describe('PreparationGroup progress lines', () => {
  it('keeps a running step its progress line', async () => {
    const mounted = await mount(
      attempt({ steps: [step({ latestDetail: 'Checking out branch' })] })
    );

    expect(mounted.texts()).toContain('Checking out branch');
    mounted.unmount();
  });

  it('keeps a completed step its progress line when its row is opened', async () => {
    const mounted = await mount(
      attempt({
        status: 'completed',
        completedAt: 3,
        steps: [step({ status: 'completed', completedAt: 2, latestDetail: 'Checking out branch' })],
      })
    );

    mounted.press('Preparation complete');
    mounted.press('Workspace setup');
    expect(mounted.texts()).toContain('Checking out branch');
    mounted.unmount();
  });

  it('keeps the progress line of the restore report its header names', async () => {
    const mounted = await mount(
      attempt({
        status: 'completed',
        completedAt: 3,
        steps: [
          step({
            id: 'incomplete',
            key: 'restore_incomplete',
            label: 'Session restore incomplete',
            status: 'failed',
            latestDetail: 'Checking out branch',
            safeError:
              'Session restore incomplete: 2 of 5 files were not restored (the patch did not apply).',
          }),
        ],
      })
    );

    expect(mounted.texts()).toContain('Checking out branch');
    mounted.unmount();
  });
});
