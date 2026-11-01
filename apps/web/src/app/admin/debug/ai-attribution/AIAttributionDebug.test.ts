import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, jest } from '@jest/globals';

const mockUseQuery = jest.fn();
const mockQueryOptions = jest.fn((_input: unknown, options?: unknown) => options);
const mockMutationOptions = jest.fn((_input: unknown, options?: unknown) => options);

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      aiAttribution: {
        getDebugData: { queryOptions: mockQueryOptions },
        deleteAttribution: { mutationOptions: mockMutationOptions },
      },
    },
  }),
}));
jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('./OrganizationCombobox', () => ({ OrganizationCombobox: () => null }));
jest.mock('./CodeIndexingCombobox', () => ({
  ProjectCombobox: () => null,
  FilePathCombobox: () => null,
  BranchCombobox: () => null,
}));

type Summary = {
  total_attributions: number;
  total_lines_added: number;
  total_lines_removed: number;
  by_status: Record<string, number>;
  by_branch: Record<string, number>;
};

const summary: Summary = {
  total_attributions: 1,
  total_lines_added: 1,
  total_lines_removed: 0,
  by_status: { accepted: 1 },
  by_branch: { main: 1 },
};

const instanceSummary: Summary = {
  total_attributions: 3,
  total_lines_added: 3,
  total_lines_removed: 0,
  by_status: { accepted: 3 },
  by_branch: { main: 2, feature: 1 },
};

const attribution = {
  id: 1,
  user_id: 'user-1',
  organization_id: 'org-1',
  project_id: 'P/src',
  branch: 'main',
  file_path: 'a.ts',
  status: 'accepted',
  task_id: 'task-a',
  created_at: '2026-10-31 23:58:40',
  lines_added: [
    {
      id: 1,
      attributions_metadata_id: 1,
      line_number: 3,
      line_hash: 'a'.repeat(40),
    },
  ],
  lines_removed: [],
};

function debugResponse(instance_summary?: typeof instanceSummary) {
  return {
    success: true as const,
    data: {
      doKey: 'org-1/P/src/a.ts',
      attributions: [attribution],
      summary,
      ...(instance_summary === undefined ? {} : { instance_summary }),
    },
  };
}

async function renderPanel(debugData: unknown) {
  mockUseQuery.mockReturnValue({ data: debugData, isLoading: false, error: null });
  // Imported after the mocks are set up, because the hoisted jest.mock factories
  // close over these module-scope spies and would read them before assignment.
  const { AIAttributionDebug } = await import('./AIAttributionDebug');
  return renderToStaticMarkup(React.createElement(AIAttributionDebug));
}

describe('attribution debug panel totals', () => {
  it('labels the cards as the selected target and reports the instance totals separately', async () => {
    const html = await renderPanel(debugResponse(instanceSummary));

    expect(html).toContain('Counts for the selected target');
    expect(html).toContain('This instance holds 3 attributions in total');
    expect(html).toContain('Attribution #1');
  });

  it('omits the instance line when the target carries every record', async () => {
    const html = await renderPanel(debugResponse(summary));

    expect(html).toContain('Counts for the selected target');
    expect(html).not.toContain('This instance holds');
  });

  it('renders the listing when the worker answers without the instance totals', async () => {
    const html = await renderPanel(debugResponse(undefined));

    expect(html).toContain('Attribution #1');
    expect(html).not.toContain('Counts for the selected target');
    expect(html).not.toContain('This instance holds');
  });
});
