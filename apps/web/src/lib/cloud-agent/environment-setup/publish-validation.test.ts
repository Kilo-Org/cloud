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
  it('rejects a multi-repository draft on an allocation that cannot host it', () => {
    const multiRepository = draft({
      sandboxAllocation: 'vercel-small',
      repositories: [
        { platform: 'github', repoFullName: 'Kilo-Org/cloud' },
        { platform: 'github', repoFullName: 'Kilo-Org/web' },
      ],
    });

    expect(() => assertDraftPublishable(multiRepository)).toThrow(TRPCError);
    expect(() => assertDraftPublishable(multiRepository)).toThrow(
      'A multi-repository environment needs an isolated Cloudflare sandbox allocation'
    );
  });

  it('allows a single-repository draft on the same allocation', () => {
    const singleRepository = draft({
      sandboxAllocation: 'vercel-small',
      repositories: [{ platform: 'github', repoFullName: 'Kilo-Org/cloud' }],
    });

    expect(() => assertDraftPublishable(singleRepository)).not.toThrow();
  });
});
