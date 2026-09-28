import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProfileOverviewScreen } from '@/components/profiles/profile-overview-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile Overview mounted tests. The `vi.mock` calls
 * stay in each test file (they must be hoisted per file); everything that does
 * not depend on the hoisted mock state lives here so no mounted test file
 * grows past the lint line budget.
 */

/** The profile detail the mocked `useAgentProfile` returns. */
export type TestProfileDetail = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  updatedAt: string;
  vars: unknown[];
  commands: unknown[];
  kiloCommands: unknown[];
  mcpServers: unknown[];
  skills: unknown[];
  agents: unknown[];
};

type TestAlertButton = { style: string; onPress?: () => void };

/** The mock surface `Alert.alert` exposes to the harness. */
export type TestAlertMock = { mock: { calls: unknown[][] } };

export function testProfile(overrides: Partial<TestProfileDetail> = {}): TestProfileDetail {
  return {
    id: 'profile-1',
    name: 'Backend debugging',
    description: 'Old description',
    isDefault: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    vars: [],
    commands: [],
    kiloCommands: [],
    mcpServers: [],
    skills: [],
    agents: [],
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

export function findRow(root: ReactTestInstance, title: string): ReactTestInstance {
  const row = findAll(root, 'ConfigureRow').find(node => node.props.title === title);
  if (!row) {
    throw new Error(`row ${title} was not rendered`);
  }
  return row;
}

function pressButton(root: ReactTestInstance, index: number): void {
  const button = findAll(root, 'Button')[index];
  if (!button) {
    throw new Error(`button ${index} was not rendered`);
  }
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
}

export function changeText(root: ReactTestInstance, label: string, value: string): void {
  act(() => {
    (findField(root, label).props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

/** Confirm the destructive Alert button the screen raised. */
function confirmAlert(alert: TestAlertMock): void {
  const buttons = alert.mock.calls[0]?.[2] as TestAlertButton[] | undefined;
  const destructive = buttons?.find(button => button.style === 'destructive');
  if (!destructive?.onPress) {
    throw new Error('destructive alert button was not registered');
  }
  destructive.onPress();
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string) {
  return renderWithProviders(
    createElement(ProfileOverviewScreen, { profileId: 'profile-1', organizationId })
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
      createElement(ProfileOverviewScreen, { profileId: 'profile-1', organizationId })
    )
  );
}

export async function pressSave(root: ReactTestInstance): Promise<void> {
  await act(async () => {
    pressButton(root, 0);
    await Promise.resolve();
  });
}

export async function pressDelete(root: ReactTestInstance, alert: TestAlertMock): Promise<void> {
  await act(async () => {
    pressButton(root, 1);
    confirmAlert(alert);
    await Promise.resolve();
  });
}
