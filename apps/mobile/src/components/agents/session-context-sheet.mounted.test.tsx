/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx). */
import { type ComponentProps, createElement, type ReactElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { Text } from '@/components/ui/text';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { SessionContextSheet } from './session-context-sheet';

const holder = vi.hoisted(() => ({
  instances: [] as unknown[],
  isPending: false,
  copied: [] as string[],
  copyResult: true as boolean | Promise<boolean>,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { instances: holder.instances }, isPending: holder.isPending }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: { listInstances: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('./session-row-actions', () => ({
  copySessionId: async (id: string) => {
    await Promise.resolve();
    holder.copied.push(id);
    return holder.copyResult;
  },
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => i18n.t(key) }),
  };
});
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#999' }),
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/agents/context-usage-ring', () => ({
  ContextUsageRing: 'ContextUsageRing',
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));

const INFO: SessionContextInfo = {
  contextTokens: 1000,
  providerID: 'kilo',
  modelID: 'claude',
  contextWindow: 10_000,
  percentage: 10,
};

function sheetElement(
  overrides: Partial<ComponentProps<typeof SessionContextSheet>> = {}
): ReactElement {
  return createElement(SessionContextSheet, {
    visible: true,
    info: INFO,
    sessionId: 'ses-123',
    sessionTitle: 'Greeting',
    activeSessionType: null,
    ownerConnectionId: null,
    modelDisplay: 'Claude',
    providerDisplay: 'Kilo',
    totalCostMicrodollars: null,
    breakdownCostUsd: 0,
    messages: [],
    modelOptions: [],
    onClose: vi.fn<() => void>(),
    ...overrides,
  });
}

async function mountSheet(
  overrides: Partial<ComponentProps<typeof SessionContextSheet>> = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(sheetElement(overrides));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

function textValues(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => node.type === Text)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string');
}

function pressByTestID(renderer: TestRenderer.ReactTestRenderer, testID: string): void {
  const target = renderer.root.findAll(node => node.props.testID === testID)[0];
  if (!target) {
    throw new Error(`missing testID ${testID}`);
  }
  (target.props.onPress as () => void)();
}

beforeEach(() => {
  holder.instances = [];
  holder.isPending = false;
  holder.copied = [];
  holder.copyResult = true;
});

describe('SessionContextSheet session id and running on', () => {
  it('shows the session title above the id row so the sheet names its session', async () => {
    const renderer = await mountSheet({ sessionTitle: 'Greeting' });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.session.title'));
    expect(values).toContain('Greeting');
    await unmount(renderer);
  });

  it('shows the session id and copies it from the row call to action', async () => {
    const renderer = await mountSheet();
    expect(textValues(renderer)).toContain('ses-123');
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-id');
      await Promise.resolve();
    });
    expect(holder.copied).toEqual(['ses-123']);
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agents.sessionRow.idCopied'));
    // The row keeps its call-to-action name beside the outcome, so the sheet
    // still names the row after the copy completes.
    expect(values).toContain(i18n.t('agents.sessionRow.copyId'));
    await unmount(renderer);
  });

  it('shows the could-not-copy outcome and retries from the same row', async () => {
    holder.copyResult = false;
    const renderer = await mountSheet();
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-id');
      await Promise.resolve();
    });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agents.sessionRow.couldNotCopyId'));
    expect(values).not.toContain(i18n.t('agents.sessionRow.idCopied'));
    expect(values).toContain(i18n.t('agents.sessionRow.copyId'));

    holder.copyResult = true;
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-id');
      await Promise.resolve();
    });
    expect(holder.copied).toEqual(['ses-123', 'ses-123']);
    expect(textValues(renderer)).toContain(i18n.t('agents.sessionRow.idCopied'));
    expect(textValues(renderer)).not.toContain(i18n.t('agents.sessionRow.couldNotCopyId'));
    await unmount(renderer);
  });

  it('resets the copy feedback to the call to action when the sheet closes', async () => {
    const renderer = await mountSheet();
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-id');
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain(i18n.t('agents.sessionRow.idCopied'));
    await act(async () => {
      renderer.update(sheetElement({ visible: false }));
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain(i18n.t('agents.sessionRow.copyId'));
    expect(textValues(renderer)).not.toContain(i18n.t('agents.sessionRow.idCopied'));
    await unmount(renderer);
  });

  it.each([
    { success: true, resolveWhileClosed: true },
    { success: false, resolveWhileClosed: true },
    { success: true, resolveWhileClosed: false },
    { success: false, resolveWhileClosed: false },
  ])(
    'ignores a late copy result after closing (success=$success, resolveWhileClosed=$resolveWhileClosed)',
    async ({ success, resolveWhileClosed }) => {
      const pendingCopy = Promise.withResolvers<boolean>();
      holder.copyResult = pendingCopy.promise;
      const renderer = await mountSheet();
      await act(async () => {
        pressByTestID(renderer, 'session-context-sheet-copy-id');
        await Promise.resolve();
      });
      expect(textValues(renderer)).toContain(i18n.t('agents.sessionRow.copyId'));
      expect(textValues(renderer)).not.toContain(i18n.t('agents.sessionRow.idCopied'));
      expect(textValues(renderer)).not.toContain(i18n.t('agents.sessionRow.couldNotCopyId'));
      await act(async () => {
        renderer.update(sheetElement({ visible: false }));
        await Promise.resolve();
      });
      if (!resolveWhileClosed) {
        await act(async () => {
          renderer.update(sheetElement());
          await Promise.resolve();
        });
      }
      await act(async () => {
        pendingCopy.resolve(success);
        await pendingCopy.promise;
      });
      if (resolveWhileClosed) {
        await act(async () => {
          renderer.update(sheetElement());
          await Promise.resolve();
        });
      }
      const values = textValues(renderer);
      expect(values).toContain(i18n.t('agents.sessionRow.copyId'));
      expect(values).not.toContain(i18n.t('agents.sessionRow.idCopied'));
      expect(values).not.toContain(i18n.t('agents.sessionRow.couldNotCopyId'));

      holder.copyResult = true;
      await act(async () => {
        pressByTestID(renderer, 'session-context-sheet-copy-id');
        await Promise.resolve();
      });
      expect(holder.copied).toEqual(['ses-123', 'ses-123']);
      expect(textValues(renderer)).toContain(i18n.t('agents.sessionRow.idCopied'));
      await unmount(renderer);
    }
  );

  it('shows the owning instance under the picker Run on label for a live CLI session', async () => {
    holder.instances = [
      { connectionId: 'conn-1', name: 'laptop', projectName: 'kilo', kind: 'cli' },
      { connectionId: 'conn-2', name: 'desktop', projectName: 'cloud', kind: 'cli' },
    ];
    const renderer = await mountSheet({ activeSessionType: 'remote', ownerConnectionId: 'conn-2' });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.instancePicker.runOn'));
    expect(values).toContain('desktop · cloud');
    await unmount(renderer);
  });

  it('shows the Cloud Agent target for a live cloud session', async () => {
    const renderer = await mountSheet({ activeSessionType: 'cloud-agent' });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.instancePicker.runOn'));
    expect(values).toContain(i18n.t('agentChat.instancePicker.cloudAgent'));
    await unmount(renderer);
  });

  it('reserves the Run on row while the connected instances load', async () => {
    holder.isPending = true;
    const renderer = await mountSheet({ activeSessionType: 'remote', ownerConnectionId: 'conn-2' });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.instancePicker.runOn'));
    expect(values).toContain(i18n.t('common.loading'));
    await unmount(renderer);
  });

  it('hides the Run on row for a read-only session', async () => {
    const renderer = await mountSheet({ activeSessionType: 'read-only' });
    expect(textValues(renderer)).not.toContain(i18n.t('agentChat.instancePicker.runOn'));
    await unmount(renderer);
  });

  it('hides the Run on row when a live CLI target is not connected', async () => {
    holder.instances = [
      { connectionId: 'conn-1', name: 'laptop', projectName: 'kilo', kind: 'cli' },
    ];
    const renderer = await mountSheet({
      activeSessionType: 'remote',
      ownerConnectionId: 'conn-missing',
    });
    expect(textValues(renderer)).not.toContain(i18n.t('agentChat.instancePicker.runOn'));
    await unmount(renderer);
  });
});
