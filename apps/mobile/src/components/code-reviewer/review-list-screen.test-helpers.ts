// Test helpers shared by the review-list mounted tests. The review factory and
// the FlatList finder live here rather than in the test file so it stays under
// the repo's max-lines limit.

import { type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';

export type ReviewStub = {
  id: string;
  pr_title: string;
  repo_full_name: string;
  pr_number: number;
  status: string;
  created_at: string;
};

export function review(id: string, prTitle = `Review ${id}`): ReviewStub {
  return {
    id,
    pr_title: prTitle,
    repo_full_name: 'org/repo',
    pr_number: 1,
    status: 'completed',
    created_at: '2026-09-01T00:00:00Z',
  };
}

export function firstList(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => String(node.type) === 'FlatList');
}
