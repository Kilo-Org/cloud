import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProfileVariablesScreen } from '@/components/profiles/profile-variables-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile Variables mounted tests. The `vi.mock` calls
 * stay in the test file (they must be hoisted there); everything that does not
 * depend on the hoisted mock state lives here.
 */

type TestVar = { key: string; value: string; isSecret: boolean };

/** The variable list the mocked `useAgentProfileVars` returns. */
export type TestVars = TestVar[];

export function testVars(vars: TestVar[] = []): TestVars {
  return vars;
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

export function findPressable(root: ReactTestInstance, label: string): ReactTestInstance {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`pressable ${label} was not rendered`);
  }
  return pressable;
}

export function pressPressable(root: ReactTestInstance, label: string): void {
  const pressable = findPressable(root, label);
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = findAll(root, 'Button').find(
    node => node.findAll(child => child.props.children === label).length > 0
  );
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

function changeField(field: ReactTestInstance, value: string): void {
  act(() => {
    (field.props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

export function changeText(root: ReactTestInstance, label: string, value: string): void {
  changeField(findField(root, label), value);
}

type TestSwitchProps = { value: boolean; onValueChange: (value: boolean) => void };

/** The form's secret toggle; the mocked `react-native` renders it as a node. */
function findSwitch(root: ReactTestInstance): ReactTestInstance {
  const node = findAll(root, 'Switch')[0];
  if (!node) {
    throw new Error('the form rendered no Switch');
  }
  return node;
}

export function isSecretToggleOn(root: ReactTestInstance): boolean {
  const props: Record<string, unknown> = findSwitch(root).props;
  return props.value === true;
}

export function toggleSecret(root: ReactTestInstance, value: boolean): void {
  const props: Record<string, unknown> = findSwitch(root).props;
  const onValueChange = props.onValueChange;
  if (typeof onValueChange !== 'function') {
    throw new TypeError('the secret toggle rendered no onValueChange');
  }
  // The renderer's props are untyped records; the node above is the Switch itself.
  const handler = onValueChange as TestSwitchProps['onValueChange'];
  act(() => {
    handler(value);
  });
}

type TestConfirmRequest = { onConfirm?: () => void };

/** The mock surface `useConfirmDialog().confirm` exposes to the harness. */
export type TestConfirmMock = { mock: { calls: unknown[][] } };

/** Fire the last confirm request the screen raised through the in-app dialog. */
export function confirmRequest(confirm: TestConfirmMock): void {
  const request = confirm.mock.calls.at(-1)?.[0] as TestConfirmRequest | undefined;
  if (!request?.onConfirm) {
    throw new Error('the destructive confirm request was not registered');
  }
  request.onConfirm();
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string) {
  return renderWithProviders(
    createElement(ProfileVariablesScreen, { profileId: 'profile-1', organizationId })
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
      createElement(ProfileVariablesScreen, { profileId: 'profile-1', organizationId })
    )
  );
}
