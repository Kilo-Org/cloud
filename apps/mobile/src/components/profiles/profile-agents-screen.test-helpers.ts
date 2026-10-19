import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';

import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Shared harness for the Profile Agents mounted tests. The `vi.mock` calls
 * stay in the test file (they must be hoisted there); everything that does not
 * depend on the hoisted mock state lives here.
 */

/** The agent detail the mocked `useAgentProfile` returns. */
export type TestProfileDetail = {
  id: string;
  agents: AgentSource[];
};

export function testProfile(agents: AgentSource[] = []): TestProfileDetail {
  return { id: 'profile-1', agents };
}

export function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const nodes = findAll(root, type);
  const node = nodes[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

type MountOptions = { queryClient?: QueryClient };

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
export function mountScreen(organizationId?: string, options: MountOptions = {}) {
  return renderWithProviders(
    createElement(ProfileAgentsScreen, { profileId: 'profile-1', organizationId }),
    options
  );
}
