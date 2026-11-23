import type {
  EnvironmentRepositoryEntry,
  EnvironmentResponse,
} from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import { assertDraftPublishable } from './publish-validation';

function draft(
  overrides: {
    repositories?: EnvironmentRepositoryEntry[];
    sandboxAllocation?: string | null;
  } = {}
): EnvironmentResponse {
  return {
    id: 'env_1',
    name: 'Draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plainVars: [],
    commands: ['npm install'],
    startCommands: [],
    configurationRevision: 1,
    sandboxAllocation: 'vercel-small',
    egressMode: null,
    egressAllowlist: null,
    egressRequiredHosts: [],
    isDraft: true,
    secretKeys: [],
    repositories: [{ platform: 'github', repoFullName: 'Kilo-Org/cloud' }],
    ...overrides,
  };
}

describe('assertDraftPublishable', () => {
  const repositories: EnvironmentRepositoryEntry[] = [
    { platform: 'github', repoFullName: 'Kilo-Org/cloud' },
    { platform: 'github', repoFullName: 'Kilo-Org/web' },
  ];

  it('rejects a multi-repository draft on the shared sandbox', () => {
    const multiRepository = draft({
      sandboxAllocation: 'cloudflare-shared',
      repositories,
    });

    expect(() => assertDraftPublishable(multiRepository)).toThrow(TRPCError);
    expect(() => assertDraftPublishable(multiRepository)).toThrow(
      'A multi-repository environment cannot run on the shared sandbox'
    );
  });

  it('allows a multi-repository draft on Vercel', () => {
    const multiRepository = draft({
      sandboxAllocation: 'vercel-small',
      repositories,
    });

    expect(() => assertDraftPublishable(multiRepository)).not.toThrow();
  });
});
