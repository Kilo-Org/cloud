import { createElement } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach } from 'vitest';
import * as z from 'zod';

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

type TestConfirmRequest = { onConfirm?: () => void };

/** The mock surface `useConfirmDialog().confirm` exposes to the harness. */
export type TestConfirmMock = { mock: { calls: unknown[][] } };

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

/** Return the state the overview reads to its idle values before each test. */
export function resetOverviewState(state: {
  query: {
    data: TestProfileDetail | undefined;
    isError: boolean;
    isPending: boolean;
    isRefetching: boolean;
  };
  mutations: { update: { isPending: boolean }; deleteProfile: { isPending: boolean } };
}): void {
  Object.assign(state.query, {
    data: undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
  });
  Object.assign(state.mutations.update, { isPending: false });
  Object.assign(state.mutations.deleteProfile, { isPending: false });
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

/** A button element's props, as the screen composed them. */
const ActionButtonSchema = z.object({
  props: z.object({
    onPress: z.custom<() => void>(value => typeof value === 'function'),
    children: z.object({ props: z.object({ children: z.string() }) }),
  }),
});

/** The props the screen hands the mocked `QueryError`. */
const QueryErrorPropsSchema = z.object({
  variant: z.string().optional(),
  title: z.string().optional(),
  onRetry: z.custom<() => void>(value => typeof value === 'function').optional(),
  action: ActionButtonSchema.optional(),
});

/**
 * Read the mocked `QueryError`'s props. Parsed rather than cast because the
 * test renderer types every node's props as `any`, and an assertion about a
 * recovery action must fail loudly when the screen stops composing one.
 */
export function queryErrorProps(root: ReactTestInstance) {
  return QueryErrorPropsSchema.parse(findOne(root, 'QueryError').props);
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

/** Fire the last confirm request the screen raised through the in-app dialog. */
function confirmRequest(confirm: TestConfirmMock): void {
  const request = confirm.mock.calls.at(-1)?.[0] as TestConfirmRequest | undefined;
  if (!request?.onConfirm) {
    throw new Error('the destructive confirm request was not registered');
  }
  request.onConfirm();
}

/**
 * Renderers each test left open. A test that fails mid-assertion still releases
 * its tree, and `mountScreen`'s `unmount` stays safe to call twice so a test can
 * unmount as early as it likes.
 */
const openRenderers = new Set<() => void>();

afterEach(() => {
  for (const unmount of openRenderers) {
    unmount();
  }
  openRenderers.clear();
});

export async function mountScreen(
  organizationId?: string,
  stack: 'app' | 'profileTab' = 'profileTab'
) {
  const mounted = await renderWithProviders(
    createElement(ProfileOverviewScreen, { profileId: 'profile-1', organizationId, stack })
  );
  let open = true;
  const unmount = () => {
    if (!open) {
      return;
    }
    open = false;
    openRenderers.delete(unmount);
    mounted.unmount();
  };
  openRenderers.add(unmount);
  return { ...mounted, unmount };
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
      // The rerender helpers serve the Profile tab stack; an app-stack mount is
      // a single-shot read, so it never needs one.
      createElement(ProfileOverviewScreen, {
        profileId: 'profile-1',
        organizationId,
        stack: 'profileTab',
      })
    )
  );
}

export async function pressSave(root: ReactTestInstance): Promise<void> {
  await act(async () => {
    pressButton(root, 0);
    await Promise.resolve();
  });
}

export async function pressDelete(
  root: ReactTestInstance,
  confirm: TestConfirmMock
): Promise<void> {
  await act(async () => {
    pressButton(root, 1);
    confirmRequest(confirm);
    await Promise.resolve();
  });
}
