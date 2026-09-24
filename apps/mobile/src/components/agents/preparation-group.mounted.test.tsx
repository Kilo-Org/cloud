import '@/i18n';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

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
