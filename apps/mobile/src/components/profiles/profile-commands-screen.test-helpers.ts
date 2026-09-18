import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProfileCommandsScreen } from '@/components/profiles/profile-commands-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile Setup Commands mounted tests. The `vi.mock`
 * calls stay in the test file (they must be hoisted there); everything that
 * does not depend on the hoisted mock state lives here.
 */

type TestCommand = { sequence: number; command: string };

/** The profile detail the mocked `useAgentProfile` returns. */
export type TestProfileDetail = { id: string; commands: TestCommand[] };

export function testProfile(commands: string[] = []): TestProfileDetail {
  return {
    id: 'profile-1',
    commands: commands.map((command, sequence) => ({ sequence, command })),
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

export function findFields(root: ReactTestInstance): ReactTestInstance[] {
  return findAll(root, 'FormField');
}

function findPressable(root: ReactTestInstance, label: string, index: number): ReactTestInstance {
  const match = findAll(root, 'Pressable').filter(node => node.props.accessibilityLabel === label)[
    index
  ];
  if (!match) {
    throw new Error(`pressable ${label} at ${index} was not rendered`);
  }
  return match;
}

export function pressPressable(root: ReactTestInstance, label: string, index = 0): void {
  const pressable = findPressable(root, label, index);
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

export function pressableDisabled(root: ReactTestInstance, label: string, index = 0): boolean {
  return findPressable(root, label, index).props.disabled === true;
}

export function changeRowText(root: ReactTestInstance, index: number, value: string): void {
  const field = findFields(root)[index];
  if (!field) {
    throw new Error(`row ${index} was not rendered`);
  }
  act(() => {
    (field.props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

/** Commit a row the way the keyboard's return key does. */
export function commitRow(root: ReactTestInstance, index: number): void {
  const field = findFields(root)[index];
  if (!field) {
    throw new Error(`row ${index} was not rendered`);
  }
  act(() => {
    (field.props as { onSubmitEditing: () => void }).onSubmitEditing();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string) {
  return renderWithProviders(
    createElement(ProfileCommandsScreen, { profileId: 'profile-1', organizationId })
  );
}

export function rerenderScreen(
  renderer: ReactTestRenderer,
  queryClient: QueryClient,
  organizationId?: string
): void {
  renderer.update(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileCommandsScreen, { profileId: 'profile-1', organizationId })
    )
  );
}
