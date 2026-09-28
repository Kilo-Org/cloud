import { type ComponentProps, createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

import { NewSessionRepositorySection } from './new-session-repository-section';
import { type NewSessionRepository, type RepositoryGroup } from './new-session-repository-state';

export const githubRow: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
export const gitlabRow: NewSessionRepository = {
  platform: 'gitlab',
  fullName: 'owner/repo',
  isPrivate: false,
};

export const group = (
  key: RepositoryGroup['key'],
  status: RepositoryGroup['status'],
  repositories: NewSessionRepository[] = []
): RepositoryGroup => ({ key, status, repositories });

export function mountSection(
  overrides: Partial<ComponentProps<typeof NewSessionRepositorySection>>
) {
  const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    renderer.current = TestRenderer.create(
      createElement(NewSessionRepositorySection, {
        disabled: false,
        isRetrying: false,
        onChange: vi.fn(() => undefined),
        onConnect: vi.fn(() => undefined),
        onRefreshRepos: vi.fn(() => undefined),
        repositories: [githubRow, gitlabRow],
        recents: [],
        groups: [group('github', 'repos'), group('gitlab', 'repos')],
        value: '',
        organizationId: undefined,
        isCloneEntry: false,
        ...overrides,
      })
    );
  });
  const created = renderer.current;
  if (created === null) {
    throw new Error('the section did not render');
  }
  return created;
}

export function branchSelectorProps(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('RepositoryBranchSelector' as never)[0]?.props as
    | {
        repository: NewSessionRepository | null;
        organizationId: string | undefined;
        disabled: boolean;
      }
    | undefined;
}

export function renderedText(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}
