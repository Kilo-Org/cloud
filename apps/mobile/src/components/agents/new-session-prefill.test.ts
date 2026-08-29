/* eslint-disable max-lines -- the prefill resolver suite covers build/append/read/resolve/describe plus the platform-qualified selection resolver */
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import { normalizeSessionRepository } from './new-session-repository-state';

import {
  appendNewSessionPrefill,
  buildContinuePrefillParams,
  describePrefillFallback,
  type NewSessionPrefill,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
  resolvePrefillRepoSelection,
} from './new-session-prefill';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ════════════════════════════════════════════════════════════════
// buildContinuePrefillParams
// ════════════════════════════════════════════════════════════════

describe('buildContinuePrefillParams', () => {
  it.each([
    ['https://github.com/Kilo-Org/cloud.git', 'Kilo-Org/cloud'],
    ['git@github.com:Kilo-Org/cloud.git', 'Kilo-Org/cloud'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://GitHub.com/owner/repo', 'owner/repo'],
    ['git@GitHub.com:owner/repo.git', 'owner/repo'],
  ])('extracts owner/repo from %s', (gitUrl, expected) => {
    const params = buildContinuePrefillParams({ gitUrl, mode: 'code', model: '', variant: '' });
    expect(params.repo).toBe(expected);
    expect(params.mode).toBe('code');
  });

  it.each([
    { gitUrl: null as string | null, desc: 'null' },
    { gitUrl: 'https://github.com/group/sub/repo', desc: 'too many segments' },
  ])('omits repo when gitUrl is $desc', ({ gitUrl }) => {
    const params = buildContinuePrefillParams({ gitUrl, mode: 'code', model: '', variant: '' });
    expect(params.repo).toBeUndefined();
  });

  it('omits empty mode/model/variant', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'https://github.com/owner/repo',
      mode: '',
      model: '',
      variant: '',
    });
    expect(params.repo).toBe('owner/repo');
    expect(params.mode).toBeUndefined();
    expect(params.model).toBeUndefined();
    expect(params.variant).toBeUndefined();
  });

  it('includes model and variant when non-empty', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'https://github.com/owner/repo',
      mode: 'plan',
      model: 'anthropic/claude-sonnet-4',
      variant: 'thinking',
    });
    expect(params.repo).toBe('owner/repo');
    expect(params.mode).toBe('plan');
    expect(params.model).toBe('anthropic/claude-sonnet-4');
    expect(params.variant).toBe('thinking');
  });
});

// ════════════════════════════════════════════════════════════════
// appendNewSessionPrefill
// ════════════════════════════════════════════════════════════════

describe('appendNewSessionPrefill', () => {
  it('uses ? when base has no query string', () => {
    const result = appendNewSessionPrefill('/agent-chat/new', { repo: 'owner/repo' });
    expect(result).toBe('/agent-chat/new?prefillRepo=owner%2Frepo');
  });

  it('uses & when base already has a query string', () => {
    const result = appendNewSessionPrefill('/agent-chat/new?organizationId=org1', {
      repo: 'owner/repo',
    });
    expect(result).toBe('/agent-chat/new?organizationId=org1&prefillRepo=owner%2Frepo');
  });

  it('encodes values with special characters', () => {
    const result = appendNewSessionPrefill('/agent-chat/new', {
      model: 'anthropic/claude-sonnet-4',
      variant: 'xhigh',
    });
    expect(result).toBe(
      '/agent-chat/new?prefillModel=anthropic%2Fclaude-sonnet-4&prefillVariant=xhigh'
    );
  });

  it.each([{ repo: '', mode: '', desc: 'empty strings' }, { desc: 'no params' }])(
    'returns base unchanged with $desc',
    params => {
      const result = appendNewSessionPrefill('/agent-chat/new', params);
      expect(result).toBe('/agent-chat/new');
    }
  );

  it('appends only non-empty params', () => {
    const result = appendNewSessionPrefill('/agent-chat/new', {
      repo: 'owner/repo',
      mode: '',
      model: 'kilo-auto/efficient',
    });
    expect(result).toBe(
      '/agent-chat/new?prefillRepo=owner%2Frepo&prefillModel=kilo-auto%2Fefficient'
    );
  });
});

// ════════════════════════════════════════════════════════════════
// readNewSessionPrefill
// ════════════════════════════════════════════════════════════════

describe('readNewSessionPrefill', () => {
  it('reads string params', () => {
    const prefill = readNewSessionPrefill({
      prefillRepo: 'owner/repo',
      prefillMode: 'plan',
      prefillModel: 'anthropic/claude-sonnet-4',
      prefillVariant: 'thinking',
    });
    expect(prefill).toEqual({
      mode: 'plan',
      repo: 'owner/repo',
      model: 'anthropic/claude-sonnet-4',
      variant: 'thinking',
    });
  });

  it('takes first element of array-valued params', () => {
    const prefill = readNewSessionPrefill({
      prefillRepo: ['owner/repo', 'other/repo'],
      prefillMode: ['plan'],
    });
    expect(prefill).toEqual({ mode: 'plan', repo: 'owner/repo' });
  });

  it.each([
    ['unknown', 'unknown'],
    ['architect', 'plan'],
    ['build', 'code'],
  ])('normalizes mode "%s" to "%s"', (input, expected) => {
    const prefill = readNewSessionPrefill({ prefillMode: input });
    expect(prefill.mode).toBe(expected);
  });

  it('defaults mode to code when missing', () => {
    const prefill = readNewSessionPrefill({});
    expect(prefill.mode).toBe('code');
    expect(prefill.repo).toBeUndefined();
  });

  it('treats empty strings as absent', () => {
    const prefill = readNewSessionPrefill({
      prefillRepo: '',
      prefillMode: 'debug',
      prefillModel: '',
    });
    expect(prefill).toEqual({ mode: 'debug' });
  });

  it('handles undefined params', () => {
    const prefill = readNewSessionPrefill({ prefillRepo: undefined, prefillMode: undefined });
    expect(prefill).toEqual({ mode: 'code' });
  });
});

// ════════════════════════════════════════════════════════════════
// resolvePrefillModel
// ════════════════════════════════════════════════════════════════

describe('resolvePrefillModel', () => {
  const catalog = [
    { id: 'anthropic/claude-sonnet-4', variants: ['default', 'thinking'] },
    { id: 'kilo-auto/efficient', variants: [] },
  ];

  it('matches exactly and keeps requested variant', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'thinking',
    });
    expect(result).toEqual({ model: 'anthropic/claude-sonnet-4', variant: 'thinking' });
  });

  it('falls back to first variant when requested variant is unsupported', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'xhigh',
    });
    expect(result).toEqual({ model: 'anthropic/claude-sonnet-4', variant: 'default' });
  });

  it('falls back to empty string variant when no variants exist', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'kilo-auto/efficient',
      variant: 'thinking',
    });
    expect(result).toEqual({ model: 'kilo-auto/efficient', variant: '' });
  });

  it.each([
    { model: 'unknown/model' },
    { model: 'anthropic/claude-sonnet-4', catOverride: [] as { id: string; variants: string[] }[] },
    { model: undefined },
    { model: '' },
  ])('returns null when model="%s"', ({ model, catOverride }) => {
    const result = resolvePrefillModel(catOverride ?? catalog, { mode: 'code', model });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// resolvePrefillRepo
// ════════════════════════════════════════════════════════════════

describe('resolvePrefillRepo', () => {
  const repos = [{ fullName: 'Kilo-Org/cloud' }, { fullName: 'kilo-org/mobile' }];

  it('matches case-insensitively and returns canonical casing', () => {
    const result = resolvePrefillRepo(repos, { mode: 'code', repo: 'kilo-org/cloud' });
    expect(result).toBe('Kilo-Org/cloud');
  });

  it.each([
    { repo: 'other/repo', reposOverride: undefined, desc: 'no match' },
    { repo: 'Kilo-Org/cloud', reposOverride: [] as { fullName: string }[], desc: 'empty list' },
    { repo: undefined, reposOverride: undefined, desc: 'absent' },
    { repo: '', reposOverride: undefined, desc: 'empty string' },
  ])('returns null when repo is $desc', ({ repo, reposOverride }) => {
    const result = resolvePrefillRepo(reposOverride ?? repos, { mode: 'code', repo });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// resolvePrefillRepoSelection
// ════════════════════════════════════════════════════════════════

describe('resolvePrefillRepoSelection', () => {
  function repositories() {
    return (['github', 'gitlab', 'bitbucket'] as const).flatMap(provider => {
      const row = normalizeSessionRepository(
        {
          private: true,
          repositoryReference: {
            ...reference,
            repository:
              provider === 'bitbucket'
                ? {
                    provider,
                    fullName: 'Kilo-Org/cloud',
                    repositoryId: '7',
                    instanceUrl: 'https://bitbucket.org',
                    defaultBranch: 'develop',
                    workspaceUuid: 'workspace-uuid',
                  }
                : {
                    provider,
                    fullName: 'Kilo-Org/cloud',
                    repositoryId: '7',
                    instanceUrl: `https://${provider}.com`,
                    defaultBranch: 'develop',
                  },
          },
        },
        'user-1',
        'org-1'
      );
      return row ? [row] : [];
    });
  }

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'selects only the exact %s identity among same-named provider rows',
    platform => {
      const rows = repositories();
      const requested = rows.find(row => row.platform === platform);
      if (!requested) {
        throw new Error('Missing provider fixture');
      }
      expect(resolvePrefillRepoSelection(rows, { mode: 'code', repo: requested.key })).toBe(
        requested.key
      );
      expect(
        resolvePrefillRepoSelection(
          rows.filter(row => row !== requested),
          { mode: 'code', repo: requested.key }
        )
      ).toBeNull();
    }
  );

  it.each(['Kilo-Org/cloud', 'kilo-org/CLOUD', 'https://github.com/Kilo-Org/cloud.git'])(
    'does not infer legacy uniqueness for %s from one visible GitHub integration',
    repo => {
      const rows = repositories().filter(row => row.platform === 'github');
      expect(rows).toHaveLength(1);
      expect(resolvePrefillRepoSelection(rows, { mode: 'code', repo })).toBeNull();
    }
  );

  it.each([
    { repo: 'gh/other', desc: 'no match' },
    { repo: undefined, desc: 'absent' },
    { repo: '', desc: 'empty string' },
  ])('returns null when repo is $desc', ({ repo }) => {
    expect(resolvePrefillRepoSelection(repositories(), { mode: 'code', repo })).toBeNull();
  });
});

const reference: LaunchRepositoryReference = {
  repository: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example.com/base',
    repositoryId: '7',
    fullName: 'group/nested/Repo',
    defaultBranch: 'develop',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'org-1' },
    integrationId: 'integration-1',
  },
};

it.each([
  'https://git.example.com/base/group/nested/Repo.git',
  'git@git.example.com:base/group/nested/Repo.git',
])('preserves the self-managed URL %s but requires an exact identity for selection', gitUrl => {
  const params = buildContinuePrefillParams({ gitUrl, mode: 'code', model: '', variant: '' });
  expect(params.repo).toBe(gitUrl);
  const row = normalizeSessionRepository(
    { private: true, repositoryReference: reference },
    'user-1',
    'org-1'
  );
  if (!row) {
    throw new Error('Invalid fixture');
  }
  const prefill = readNewSessionPrefill({ prefillRepo: params.repo });
  expect(resolvePrefillRepoSelection([row], prefill)).toBeNull();
  expect(resolvePrefillRepoSelection([row], { mode: 'code', repo: row.key })).toBe(row.key);
  expect(
    resolvePrefillRepoSelection([row], { mode: 'code', repo: gitUrl.replace('/Repo', '/repo') })
  ).toBeNull();
  expect(
    resolvePrefillRepoSelection([row], { mode: 'code', repo: gitUrl.replace('base/', 'other/') })
  ).toBeNull();
});

it('quarantines a legacy name or URL shared by multiple integrations instead of picking the first', () => {
  const rows = ['integration-1', 'integration-2'].flatMap(integrationId => {
    const row = normalizeSessionRepository(
      {
        private: true,
        repositoryReference: {
          ...reference,
          authorization: { ...reference.authorization, integrationId },
        },
      },
      'user-1',
      'org-1'
    );
    return row ? [row] : [];
  });
  expect(
    resolvePrefillRepoSelection(rows, {
      mode: 'code',
      repo: 'https://git.example.com/base/group/nested/Repo.git',
    })
  ).toBeNull();
  for (const row of rows) {
    expect(resolvePrefillRepoSelection(rows, { mode: 'code', repo: row.key })).toBe(row.key);
  }
  expect(
    resolvePrefillRepoSelection(rows.slice(1), { mode: 'code', repo: rows[0]?.key })
  ).toBeNull();
});

// ════════════════════════════════════════════════════════════════
// describePrefillFallback
// ════════════════════════════════════════════════════════════════

describe('describePrefillFallback', () => {
  const settled = { settled: true, matched: false };
  const matched = { settled: true, matched: true };
  const unsettled = { settled: false, matched: false };

  it('returns null when nothing requested (both sides unsettled)', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code' },
      repos: unsettled,
      models: unsettled,
    });
    expect(note).toBeNull();
  });

  it.each([
    {
      desc: 'repo unmatched, model not requested',
      prefill: { mode: 'code', repo: 'owner/repo' } satisfies NewSessionPrefill,
      repos: settled,
      models: unsettled,
      expected: i18n.t('agentChat.newSession.prefillRepoUnavailable', { repo: 'owner/repo' }),
    },
    {
      desc: 'model unmatched, repo not requested',
      prefill: { mode: 'code', model: 'anthropic/claude-sonnet-4' } satisfies NewSessionPrefill,
      repos: unsettled,
      models: settled,
      expected: i18n.t('agentChat.newSession.prefillModelUnavailable', {
        model: 'anthropic/claude-sonnet-4',
      }),
    },
    {
      desc: 'model unmatched, repository identity unresolved',
      prefill: {
        mode: 'code',
        repo: 'owner/repo',
        model: 'anthropic/claude-sonnet-4',
      } satisfies NewSessionPrefill,
      repos: unsettled,
      models: settled,
      expected: i18n.t('agentChat.newSession.prefillModelUnavailable', {
        model: 'anthropic/claude-sonnet-4',
      }),
    },
  ])('returns per-field message when $desc', ({ prefill, repos, models, expected }) => {
    expect(describePrefillFallback({ prefill, repos, models })).toBe(expected);
  });

  it.each([
    {
      desc: 'both requested, only repos settled',
      prefill: {
        mode: 'code',
        repo: 'owner/repo',
        model: 'anthropic/claude-sonnet-4',
      } satisfies NewSessionPrefill,
      repos: settled,
      models: unsettled,
    },
    {
      desc: 'both matched',
      prefill: {
        mode: 'code',
        repo: 'owner/repo',
        model: 'anthropic/claude-sonnet-4',
      } satisfies NewSessionPrefill,
      repos: matched,
      models: matched,
    },
    {
      desc: 'only repo requested, matched',
      prefill: { mode: 'code', repo: 'owner/repo' } satisfies NewSessionPrefill,
      repos: matched,
      models: unsettled,
    },
    {
      desc: 'only model requested, matched',
      prefill: { mode: 'code', model: 'anthropic/claude-sonnet-4' } satisfies NewSessionPrefill,
      repos: unsettled,
      models: matched,
    },
  ])('returns null when $desc', ({ prefill, repos, models }) => {
    expect(describePrefillFallback({ prefill, repos, models })).toBeNull();
  });

  it('returns combined message when both requested + settled + both unmatched', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo', model: 'anthropic/claude-sonnet-4' },
      repos: settled,
      models: settled,
    });
    expect(note).toBe(i18n.t('agentChat.newSession.prefillRepoAndModelUnavailable'));
  });
});
