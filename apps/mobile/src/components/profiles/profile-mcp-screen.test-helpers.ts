import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { ProfileMcpScreen } from '@/components/profiles/profile-mcp-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile MCP mounted tests. The `vi.mock` calls stay in
 * the test file (they must be hoisted there); everything that does not depend
 * on the hoisted mock state lives here.
 */

export type TestMcpServer = {
  id: string;
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  timeout: number | null;
  config: {
    command?: string[];
    url?: string;
    environment?: Record<string, string>;
    headers?: Record<string, string>;
  };
};

export function testProfile(mcpServers: TestMcpServer[] = []) {
  return { id: 'profile-1', mcpServers };
}

export function testServer(overrides: Partial<TestMcpServer> = {}): TestMcpServer {
  return {
    id: 'mcp-1',
    name: 'docs',
    type: 'local',
    enabled: true,
    timeout: null,
    config: {
      command: ['npx', '@example/mcp'],
      environment: { API_KEY: '\u2022\u2022\u2022\u2022' },
    },
    ...overrides,
  };
}

export function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

export function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

export function pressPressable(root: ReactTestInstance, label: string): void {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`pressable ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

export function pressEmptyAction(renderer: ReactTestRenderer): void {
  const action = findOne(renderer.root, 'EmptyState').props.action as {
    props: { onPress: () => void };
  };
  act(() => {
    action.props.onPress();
  });
}

export function changeText(root: ReactTestInstance, label: string, value: string): void {
  act(() => {
    (findField(root, label).props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

export function pressSheetDone(root: ReactTestInstance): void {
  act(() => {
    (findOne(root, 'SheetHeader').props as { onDone: () => void }).onDone();
  });
}

type TestAlertMock = { mock: { calls: unknown[][] } };

/** Confirm the destructive button of the first Alert the screen raised. */
export function confirmAlert(alert: TestAlertMock): void {
  const buttons = alert.mock.calls[0]?.[2] as { style: string; onPress?: () => void }[] | undefined;
  const destructive = buttons?.find(button => button.style === 'destructive');
  if (!destructive?.onPress) {
    throw new Error('destructive alert button was not registered');
  }
  destructive.onPress();
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string) {
  return renderWithProviders(
    createElement(ProfileMcpScreen, { profileId: 'profile-1', organizationId })
  );
}

/** Re-render the mounted screen against fresh mock data, keeping the providers. */
export function rerenderScreen(
  renderer: ReactTestRenderer,
  queryClient: QueryClient,
  organizationId?: string
): void {
  renderer.update(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileMcpScreen, { profileId: 'profile-1', organizationId })
    )
  );
}
