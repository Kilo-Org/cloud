import '@/i18n';
import { createElement } from 'react';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

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
    status: 'failed',
    startedAt: 1,
    revision: 1,
    ...overrides,
  };
}

function failedAttempt(overrides: Partial<PreparationAttempt>): PreparationAttempt {
  return {
    id: 'attempt-1',
    triggerMessageId: 'message-1',
    status: 'failed',
    startedAt: 1,
    completedAt: 2,
    revision: 2,
    steps: [],
    ...overrides,
  };
}

async function mount(candidate: PreparationAttempt) {
  const mounted = await renderWithProviders(
    createElement(PreparationGroup, { attempt: candidate })
  );
  const group = () => {
    const node = mounted.renderer.root.findAllByType('Pressable')[0];
    if (!node) {
      throw new Error('PreparationGroup pressable not found');
    }
    return node;
  };
  const texts = () =>
    mounted.renderer.root
      .findAllByType('Text')
      .flatMap(node => node.children)
      .filter((child): child is string => typeof child === 'string');
  const outputTails = () =>
    mounted.renderer.root
      .findAll(node => (node.type as string) === 'MonoScrollBlock')
      .map(node => node.props.content);
  return { ...mounted, group, texts, outputTails };
}

describe('PreparationGroup failure copy', () => {
  it('titles two stage-less failures apart and keeps the remedy in the body', async () => {
    const container = await mount(failedAttempt({ safeError: 'container_limit_reached' }));
    expect(container.group().props.accessibilityLabel).toBe('Container limit reached.');
    expect(container.texts()).toContain('Stop an existing container before starting another.');
    container.unmount();

    const credentials = await mount(failedAttempt({ safeError: 'credential_upgrade_required' }));
    expect(credentials.group().props.accessibilityLabel).toBe(
      'This session is missing a required credential upgrade.'
    );
    expect(credentials.texts()).toContain('Start a new session to continue.');
    credentials.unmount();
  });

  it('titles a one-sentence failure with that sentence and adds no body line', async () => {
    const mounted = await mount(failedAttempt({ safeError: 'preparation_timeout' }));
    expect(mounted.group().props.accessibilityLabel).toBe('Environment preparation timed out');
    expect(mounted.renderer.root.findAllByType('Check')).toHaveLength(0);
    expect(mounted.texts()).toEqual(['Environment preparation timed out']);
    mounted.unmount();
  });

  it('names the failed stage and keeps that stage out of the body it named', async () => {
    const mounted = await mount(
      failedAttempt({
        steps: [
          step({
            id: 'provision',
            key: 'sandbox_provision',
            safeError: 'sandbox_out_of_memory',
          }),
          step({ id: 'boot', key: 'sandbox_boot', safeError: 'sandbox_lost' }),
        ],
      })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Provisioning sandbox failed');
    expect(mounted.group().findAllByType('AlertCircle').length).toBeGreaterThan(0);
    // The header names the provisioning stage, so its cause stands in for its
    // row and the later stage keeps its own expandable row.
    expect(mounted.texts()).toContain('The sandbox ran out of memory');
    expect(mounted.texts()).not.toContain('Provisioning sandbox');
    expect(mounted.texts()).toContain('Starting sandbox');
    mounted.unmount();
  });

  it('keeps a named setup command its own evidence in the body', async () => {
    const mounted = await mount(
      failedAttempt({
        safeError: 'Setup command 2 failed',
        steps: [
          step({ id: 'commands', key: 'setup_commands' }),
          step({
            id: 'command',
            key: 'setup_commands',
            kind: 'setup_command',
            commandIndex: 1,
            commandCount: 2,
            command: 'pnpm run build',
            outputTail: 'ELIFECYCLE Command failed with exit code 1.',
            exitCode: 1,
          }),
        ],
      })
    );
    expect(mounted.group().props.accessibilityLabel).toBe('Setup command 2 of 2 failed');
    // The header names the command, so its row is gone; the command, its output
    // and its exit code stay where the row used to show them.
    expect(mounted.texts()).not.toContain('Setup command 2 of 2');
    expect(mounted.texts()).toContain('pnpm run build');
    expect(mounted.texts()).toContain('Exit code: 1');
    expect(mounted.outputTails()).toContain('ELIFECYCLE Command failed with exit code 1.');
    mounted.unmount();
  });
});
