import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProfileSkillsScreen } from '@/components/profiles/profile-skills-screen';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile Skills mounted tests. The `vi.mock` calls
 * stay in the test file (they must be hoisted there); everything that does not
 * depend on the hoisted mock state lives here.
 */

export type TestSkill = {
  id: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  rawMarkdown: string;
};

/** The profile detail the mocked `useAgentProfile` returns. */
export type TestProfileDetail = { id: string; skills: TestSkill[] };

export function testProfile(skills: TestSkill[] = []): TestProfileDetail {
  return { id: 'profile-1', skills };
}

export function testSkill(overrides: Partial<TestSkill> = {}): TestSkill {
  return {
    id: 'skill-1',
    name: 'code-review',
    sourceType: 'custom',
    enabled: true,
    rawMarkdown: 'Body',
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

function findPressable(root: ReactTestInstance, label: string): ReactTestInstance {
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

/** Press the add CTA the empty state renders through its `action` prop. */
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

/** Press the sheet's Save, which the mocked `SheetHeader` exposes as `onDone`. */
export function pressSheetDone(root: ReactTestInstance): void {
  act(() => {
    (findOne(root, 'SheetHeader').props as { onDone: () => void }).onDone();
  });
}

/** The mock surface `Alert.alert` exposes to the harness. */
export type TestAlertMock = { mock: { calls: unknown[][] } };

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
    createElement(ProfileSkillsScreen, { profileId: 'profile-1', organizationId })
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
      createElement(ProfileSkillsScreen, { profileId: 'profile-1', organizationId })
    )
  );
}
