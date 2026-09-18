import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the repo-bindings mounted tests. The `vi.mock` calls stay
 * in the test file (they must be hoisted there); everything that does not depend
 * on the hoisted mock state lives here.
 */

export type TestBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};

export function testBinding(overrides: Partial<TestBinding> = {}): TestBinding {
  return {
    repoFullName: 'acme/api',
    platform: 'github',
    profileId: 'profile-1',
    profileName: 'Backend debugging',
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

/** Press the first Pressable (or Button) carrying an accessibility label. */
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

export function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = findAll(root, 'Button').find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`button ${label} was not rendered`);
  }
  return button;
}

export function pressButton(root: ReactTestInstance, label: string): void {
  const button = findButton(root, label);
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
}

/**
 * Type into the picker's search input (its accessibility label matches) and
 * yield once so the deferred query — the input stays urgent while the filtered
 * rows trail — commits before the caller asserts.
 */
export async function changeSearch(root: ReactTestInstance, value: string): Promise<void> {
  const input = findAll(root, 'TextInput')[0];
  if (!input) {
    throw new Error('search input was not rendered');
  }
  await act(async () => {
    (input.props as { onChangeText: (v: string) => void }).onChangeText(value);
    await Promise.resolve();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string) {
  return renderWithProviders(createElement(RepoBindingsScreen, { organizationId }));
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
      createElement(RepoBindingsScreen, { organizationId })
    )
  );
}
