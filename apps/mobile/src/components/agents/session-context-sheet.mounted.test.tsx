/* eslint-disable max-lines -- The sheet's two concerns (the auto-approve row and the session identity rows) each carry their own mock harness and assertions; splitting them would duplicate the renderer setup. */

import { type ComponentProps, createElement, type ReactElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { type SessionAutoApproveState } from './session-auto-approve';
import { SessionContextSheet } from './session-context-sheet';

const holder = vi.hoisted(() => ({
  instances: [] as unknown[],
  isPending: false,
  copied: [] as string[],
  copyResult: true as boolean | Promise<boolean>,
  copiedLinks: [] as { sessionId: string; anchorMessageId: string | null }[],
  linkCopyResult: true as boolean | Promise<boolean>,
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
  copySessionLink: async (sessionId: string, anchorMessageId: string | null) => {
    await Promise.resolve();
    holder.copiedLinks.push({ sessionId, anchorMessageId });
    return holder.linkCopyResult;
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
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-svg', () => ({ Circle: 'Circle', default: 'Svg' }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    hairSoft: '#eeeeee',
    mutedForeground: '#666666',
  }),
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

const WARNING_COPY =
  'Approve permission asks for this session automatically. Tools then run without a prompt.';
const UNAVAILABLE_COPY = 'This session cannot receive permission asks.';

const INFO: SessionContextInfo = {
  contextTokens: 1000,
  providerID: 'kilo',
  modelID: 'claude',
  contextWindow: 10_000,
  percentage: 10,
};

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function renderSheet(
  state: SessionAutoApproveState,
  onAutoApproveChange: (enabled: boolean) => void = vi.fn<(enabled: boolean) => void>(),
  overrides: Partial<ComponentProps<typeof SessionContextSheet>> = {}
) {
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionContextSheet, {
        visible: true,
        info: INFO,
        sessionId: 'ses-123',
        anchorMessageId: null,
        sessionTitle: 'Greeting',
        activeSessionType: null,
        ownerConnectionId: null,
        modelDisplay: 'Model X',
        providerDisplay: 'Kilo',
        totalCostMicrodollars: null,
        breakdownCostUsd: 0,
        messages: [],
        modelOptions: [],
        autoApproveState: state,
        onAutoApproveChange,
        onClose: vi.fn<() => void>(),
        connectionDisplay: 'connected',
        onRetryConnection: vi.fn<() => void>(),
        ...overrides,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByTestID(root: Instance, testID: string): Instance[] {
  return root.findAll(node => node.props.testID === testID);
}

function indexOfTestID(root: Instance, testID: string): number {
  return root.findAll(() => true).findIndex(node => node.props.testID === testID);
}

function indexOfType(root: Instance, type: string): number {
  return root
    .findAll(() => true)
    .findIndex(node => typeof node.type === 'string' && (node.type as string) === type);
}

function findByType(root: Instance, type: string): Instance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function switchNode(root: Instance): Instance {
  const found = findByTestID(root, 'session-auto-approve-switch');
  if (!found[0]) {
    throw new Error('switch was not rendered');
  }
  return found[0];
}

function renderedTexts(root: Instance): string[] {
  return findByType(root, 'Text').flatMap(node =>
    node.children.filter((child): child is string => typeof child === 'string')
  );
}

describe('SessionContextSheet auto-approve row', () => {
  it.each(['on', 'off', 'unavailable'] as const)(
    'renders %s controls without usage and reserves the detail rows as usage arrives',
    state => {
      const renderer = renderSheet(state, vi.fn<(enabled: boolean) => void>(), {
        info: undefined,
        modelDisplay: '',
        providerDisplay: '',
      });
      const sheet = renderer.root.findByType(SessionContextSheet);
      const props = sheet.props as ComponentProps<typeof SessionContextSheet>;
      const switchBefore = switchNode(renderer.root);
      expect(switchBefore.props.value).toBe(state === 'on');
      expect(switchBefore.props.disabled).toBe(state === 'unavailable');
      expect(renderedTexts(renderer.root)).toContain('-');
      expect(renderedTexts(renderer.root)).not.toContain('1,000');
      const labels = [
        i18n.t('common.model'),
        i18n.t('agentChat.contextUsage.provider'),
        ...(state === 'unavailable'
          ? []
          : [i18n.t('common.remaining'), i18n.t('agentChat.contextUsage.totalCost')]),
      ];
      for (const label of labels) {
        expect(renderedTexts(renderer.root)).toContain(label);
      }
      act(() => {
        renderer.update(
          createElement(SessionContextSheet, {
            ...props,
            info: INFO,
            modelDisplay: 'Model X',
            providerDisplay: 'Kilo',
          })
        );
      });
      expect(switchNode(renderer.root)).toBe(switchBefore);
      expect(renderedTexts(renderer.root)).toContain('1,000');
      for (const label of labels) {
        expect(renderedTexts(renderer.root)).toContain(label);
      }
      act(() => {
        renderer.unmount();
      });
    }
  );

  it('renders the auto-approve row first in the sheet body, above the scrolling details', () => {
    const renderer = renderSheet('on');
    const root = renderer.root;

    const rowIndex = indexOfTestID(root, 'session-auto-approve-row');
    const connectionIndex = indexOfTestID(root, 'session-context-sheet-connection');
    const ringIndex = indexOfTestID(root, 'session-context-sheet-ring');
    const headerIndex = indexOfType(root, 'SheetHeader');

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(connectionIndex).toBeGreaterThanOrEqual(0);
    expect(ringIndex).toBeGreaterThanOrEqual(0);
    // The header title ("Context usage") is above the row; the row is the
    // first body element and precedes the connection row and the usage ring
    // inside the ScrollView.
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(headerIndex).toBeLessThan(rowIndex);
    expect(rowIndex).toBeLessThan(connectionIndex);
    expect(connectionIndex).toBeLessThan(ringIndex);

    // Outside the ScrollView, so they never scroll away with the details.
    const scrollView = findByType(root, 'ScrollView')[0];
    expect(scrollView).toBeDefined();
    expect(
      scrollView?.findAll(node => node.props.testID === 'session-auto-approve-row')
    ).toHaveLength(0);
    expect(
      scrollView?.findAll(node => node.props.testID === 'session-context-sheet-connection')
    ).toHaveLength(0);

    renderer.unmount();
  });

  it.each([
    { state: 'on' as const, copy: WARNING_COPY, value: true, disabled: false },
    { state: 'off' as const, copy: WARNING_COPY, value: false, disabled: false },
    { state: 'unavailable' as const, copy: UNAVAILABLE_COPY, value: false, disabled: true },
  ])(
    'renders the $state row with its copy and switch state',
    ({ state, copy, value, disabled }) => {
      const renderer = renderSheet(state);

      expect(findByTestID(renderer.root, 'session-auto-approve-row')).toHaveLength(1);
      expect(renderedTexts(renderer.root)).toContain('Auto-approve');
      expect(renderedTexts(renderer.root)).toContain(copy);
      if (state === 'unavailable') {
        expect(renderedTexts(renderer.root)).not.toContain(WARNING_COPY);
      }
      expect(switchNode(renderer.root).props.value).toBe(value);
      expect(switchNode(renderer.root).props.disabled).toBe(disabled);

      renderer.unmount();
    }
  );

  it('forwards the next switch value to the change handler', () => {
    const onAutoApproveChange = vi.fn<(enabled: boolean) => void>();
    const renderer = renderSheet('off', onAutoApproveChange);

    act(() => {
      (switchNode(renderer.root).props.onValueChange as (next: boolean) => void)(true);
    });

    expect(onAutoApproveChange).toHaveBeenCalledWith(true);
    renderer.unmount();
  });
});

function sheetElement(
  overrides: Partial<ComponentProps<typeof SessionContextSheet>> = {}
): ReactElement {
  return createElement(SessionContextSheet, {
    visible: true,
    info: INFO,
    sessionId: 'ses-123',
    anchorMessageId: null,
    sessionTitle: 'Greeting',
    activeSessionType: null,
    ownerConnectionId: null,
    modelDisplay: 'Claude',
    providerDisplay: 'Kilo',
    totalCostMicrodollars: null,
    breakdownCostUsd: 0,
    messages: [],
    modelOptions: [],
    autoApproveState: 'on',
    onAutoApproveChange: vi.fn<(enabled: boolean) => void>(),
    onClose: vi.fn<() => void>(),
    connectionDisplay: 'connected',
    onRetryConnection: vi.fn<() => void>(),
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
  holder.copiedLinks = [];
  holder.linkCopyResult = true;
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

describe('SessionContextSheet copy link row', () => {
  it('shows the resume URL as the row value and copies it from the call to action', async () => {
    const renderer = await mountSheet();
    const expected = sessionResumeUrl({ sessionId: 'ses-123', anchorMessageId: null });
    expect(textValues(renderer)).toContain(i18n.t('common.copyLink'));
    expect(textValues(renderer)).toContain(expected);

    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });

    expect(holder.copiedLinks).toEqual([{ sessionId: 'ses-123', anchorMessageId: null }]);
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.chatLink.linkCopied'));
    // The row keeps its call-to-action name beside the outcome, so the sheet
    // still names the row after the copy completes.
    expect(values).toContain(i18n.t('common.copyLink'));
    await unmount(renderer);
  });

  it('copies the row value anchored at the position the sheet was given', async () => {
    const renderer = await mountSheet({ anchorMessageId: 'msg-42' });
    const expected = sessionResumeUrl({ sessionId: 'ses-123', anchorMessageId: 'msg-42' });
    expect(textValues(renderer)).toContain(expected);

    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });

    expect(holder.copiedLinks).toEqual([{ sessionId: 'ses-123', anchorMessageId: 'msg-42' }]);
    await unmount(renderer);
  });

  it('shows the could-not-copy outcome and retries from the same row', async () => {
    holder.linkCopyResult = false;
    const renderer = await mountSheet();
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.chatLink.couldNotCopyLink'));
    expect(values).not.toContain(i18n.t('agentChat.chatLink.linkCopied'));
    expect(values).toContain(i18n.t('common.copyLink'));

    holder.linkCopyResult = true;
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    expect(holder.copiedLinks).toHaveLength(2);
    expect(textValues(renderer)).toContain(i18n.t('agentChat.chatLink.linkCopied'));
    expect(textValues(renderer)).not.toContain(i18n.t('agentChat.chatLink.couldNotCopyLink'));
    await unmount(renderer);
  });

  it('resets the link feedback to the call to action when the sheet closes', async () => {
    const renderer = await mountSheet();
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain(i18n.t('agentChat.chatLink.linkCopied'));
    await act(async () => {
      renderer.update(sheetElement({ visible: false }));
      await Promise.resolve();
    });
    expect(textValues(renderer)).toContain(i18n.t('common.copyLink'));
    expect(textValues(renderer)).not.toContain(i18n.t('agentChat.chatLink.linkCopied'));
    await unmount(renderer);
  });

  it('keeps the link feedback independent of the session id feedback', async () => {
    const renderer = await mountSheet();
    await act(async () => {
      pressByTestID(renderer, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.chatLink.linkCopied'));
    expect(values).not.toContain(i18n.t('agents.sessionRow.idCopied'));
    await unmount(renderer);
  });
});

describe('SessionContextSheet connection row', () => {
  it.each([
    { display: 'connected' as const, copy: 'common.connected' },
    { display: 'connecting' as const, copy: 'agentChat.sessionConnection.connecting' },
    { display: 'reconnecting' as const, copy: 'agentChat.sessionConnection.reconnecting' },
    { display: 'lost' as const, copy: 'agentChat.sessionConnection.connectionLost' },
    { display: 'scheduled' as const, copy: 'common.scheduled' },
  ])('renders the Connection label and the $display copy', async ({ display, copy }) => {
    const renderer = await mountSheet({ connectionDisplay: display });
    const values = textValues(renderer);
    expect(values).toContain(i18n.t('agentChat.sessionConnection.label'));
    expect(values).toContain(i18n.t(copy));
    await unmount(renderer);
  });

  it('keeps the connection row outside the ScrollView, under the auto-approve row', async () => {
    const renderer = await mountSheet();
    const root = renderer.root;
    const rowIndex = indexOfTestID(root, 'session-auto-approve-row');
    const connectionIndex = indexOfTestID(root, 'session-context-sheet-connection');
    const ringIndex = indexOfTestID(root, 'session-context-sheet-ring');

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(connectionIndex).toBeGreaterThanOrEqual(0);
    expect(ringIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBeLessThan(connectionIndex);
    expect(connectionIndex).toBeLessThan(ringIndex);

    const scrollView = findByType(root, 'ScrollView')[0];
    expect(scrollView).toBeDefined();
    expect(
      scrollView?.findAll(node => node.props.testID === 'session-context-sheet-connection')
    ).toHaveLength(0);

    await unmount(renderer);
  });

  it('offers Retry only for a lost connection and calls the handler once', async () => {
    const onRetryConnection = vi.fn<() => void>();
    const connected = await mountSheet({ connectionDisplay: 'connected' });
    expect(findByTestID(connected.root, 'session-context-sheet-connection-retry')).toHaveLength(0);
    await unmount(connected);

    const lost = await mountSheet({ connectionDisplay: 'lost', onRetryConnection });
    expect(findByTestID(lost.root, 'session-context-sheet-connection-retry')).toHaveLength(1);
    await act(async () => {
      pressByTestID(lost, 'session-context-sheet-connection-retry');
      await Promise.resolve();
    });
    expect(onRetryConnection).toHaveBeenCalledTimes(1);
    await unmount(lost);
  });
});
