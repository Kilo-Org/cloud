import { describe, expect, it, vi } from 'vitest';

import {
  appendNewSessionPrefill,
  buildContinuePrefillParams,
  describePrefillFallback,
  type NewSessionPrefill,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from './new-session-prefill';

vi.mock('lucide-react-native', () => ({
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
    { gitUrl: 'https://gitlab.com/owner/repo.git', desc: 'non-GitHub HTTPS' },
    { gitUrl: 'git@gitlab.com:owner/repo.git', desc: 'non-GitHub scp-style' },
    { gitUrl: 'https://git.example.com/owner/repo.git', desc: 'self-hosted HTTPS' },
    { gitUrl: 'git@git.example.com:owner/repo.git', desc: 'self-hosted scp-style' },
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
    ['unknown', 'code'],
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
      expected: 'owner/repo is no longer available. Pick a repository below.',
    },
    {
      desc: 'model unmatched, repo not requested',
      prefill: { mode: 'code', model: 'anthropic/claude-sonnet-4' } satisfies NewSessionPrefill,
      repos: unsettled,
      models: settled,
      expected: 'anthropic/claude-sonnet-4 is no longer available. Using your default model.',
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
      desc: 'both requested, only models settled',
      prefill: {
        mode: 'code',
        repo: 'owner/repo',
        model: 'anthropic/claude-sonnet-4',
      } satisfies NewSessionPrefill,
      repos: unsettled,
      models: settled,
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
    expect(note).toBe(
      "The original session's repository and model are no longer available. Pick them below."
    );
  });
});
