import { describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react-native', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

import {
  appendNewSessionPrefill,
  buildContinuePrefillParams,
  describePrefillFallback,
  readNewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from './new-session-prefill';

// ════════════════════════════════════════════════════════════════
// buildContinuePrefillParams
// ════════════════════════════════════════════════════════════════

describe('buildContinuePrefillParams', () => {
  it('extracts owner/repo from https URL', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'https://github.com/Kilo-Org/cloud.git',
      mode: 'code',
      model: '',
      variant: '',
    });
    expect(params.repo).toBe('Kilo-Org/cloud');
    expect(params.mode).toBe('code');
  });

  it('extracts owner/repo from git@ SSH URL', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'git@github.com:Kilo-Org/cloud.git',
      mode: 'code',
      model: '',
      variant: '',
    });
    expect(params.repo).toBe('Kilo-Org/cloud');
  });

  it('strips .git suffix', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'https://github.com/owner/repo.git',
      mode: 'code',
      model: '',
      variant: '',
    });
    expect(params.repo).toBe('owner/repo');
  });

  it('omits repo when gitUrl is null', () => {
    const params = buildContinuePrefillParams({
      gitUrl: null,
      mode: 'code',
      model: '',
      variant: '',
    });
    expect(params.repo).toBeUndefined();
    expect(params.mode).toBe('code');
  });

  it('omits repo when gitUrl does not reduce to exactly two segments', () => {
    const params = buildContinuePrefillParams({
      gitUrl: 'https://github.com/group/sub/repo',
      mode: 'code',
      model: '',
      variant: '',
    });
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
    const result = appendNewSessionPrefill('/agent-chat/new', {
      repo: 'owner/repo',
    });
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

  it('returns base unchanged when params are empty', () => {
    const result = appendNewSessionPrefill('/agent-chat/new', {});
    expect(result).toBe('/agent-chat/new');
  });

  it('returns base unchanged when all params are empty strings', () => {
    const result = appendNewSessionPrefill('/agent-chat/new', {
      repo: '',
      mode: '',
    });
    expect(result).toBe('/agent-chat/new');
  });

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
    expect(prefill).toEqual({
      mode: 'plan',
      repo: 'owner/repo',
    });
  });

  it('normalizes unknown mode to code', () => {
    const prefill = readNewSessionPrefill({
      prefillMode: 'unknown',
    });
    expect(prefill.mode).toBe('code');
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

  it('normalizes "architect" to "plan"', () => {
    const prefill = readNewSessionPrefill({
      prefillMode: 'architect',
    });
    expect(prefill.mode).toBe('plan');
  });

  it('normalizes "build" to "code"', () => {
    const prefill = readNewSessionPrefill({
      prefillMode: 'build',
    });
    expect(prefill.mode).toBe('code');
  });

  it('handles undefined params', () => {
    const prefill = readNewSessionPrefill({
      prefillRepo: undefined,
      prefillMode: undefined,
    });
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
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet-4',
      variant: 'thinking',
    });
  });

  it('falls back to first variant when requested variant is unsupported', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'xhigh',
    });
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet-4',
      variant: 'default',
    });
  });

  it('falls back to empty string variant when no variants exist', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'kilo-auto/efficient',
      variant: 'thinking',
    });
    expect(result).toEqual({
      model: 'kilo-auto/efficient',
      variant: '',
    });
  });

  it('returns null when model is absent from catalog', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: 'unknown/model',
    });
    expect(result).toBeNull();
  });

  it('returns null when catalog is empty', () => {
    const result = resolvePrefillModel([], {
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(result).toBeNull();
  });

  it('returns null when prefill.model is absent', () => {
    const result = resolvePrefillModel(catalog, { mode: 'code' });
    expect(result).toBeNull();
  });

  it('returns null when prefill.model is empty string', () => {
    const result = resolvePrefillModel(catalog, {
      mode: 'code',
      model: '',
    });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// resolvePrefillRepo
// ════════════════════════════════════════════════════════════════

describe('resolvePrefillRepo', () => {
  const repos = [{ fullName: 'Kilo-Org/cloud' }, { fullName: 'kilo-org/mobile' }];

  it('matches case-insensitively and returns canonical casing', () => {
    const result = resolvePrefillRepo(repos, {
      mode: 'code',
      repo: 'kilo-org/cloud',
    });
    expect(result).toBe('Kilo-Org/cloud');
  });

  it('returns null for no match', () => {
    const result = resolvePrefillRepo(repos, {
      mode: 'code',
      repo: 'other/repo',
    });
    expect(result).toBeNull();
  });

  it('returns null for empty list', () => {
    const result = resolvePrefillRepo([], {
      mode: 'code',
      repo: 'Kilo-Org/cloud',
    });
    expect(result).toBeNull();
  });

  it('returns null when prefill.repo is absent', () => {
    const result = resolvePrefillRepo(repos, { mode: 'code' });
    expect(result).toBeNull();
  });

  it('returns null when prefill.repo is empty string', () => {
    const result = resolvePrefillRepo(repos, {
      mode: 'code',
      repo: '',
    });
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

  it('returns repo message when repo requested + settled + unmatched, model not requested and unsettled', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo' },
      repos: settled,
      models: unsettled,
    });
    expect(note).toBe('owner/repo is no longer available. Pick a repository below.');
  });

  it('returns model message when model requested + settled + unmatched, repo not requested and unsettled', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
      repos: unsettled,
      models: settled,
    });
    expect(note).toBe(
      'anthropic/claude-sonnet-4 is no longer available. Using your default model.'
    );
  });

  it('returns null when both requested but only one settled', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo', model: 'anthropic/claude-sonnet-4' },
      repos: settled,
      models: unsettled,
    });
    expect(note).toBeNull();
  });

  it('returns null when both requested but only models settled', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo', model: 'anthropic/claude-sonnet-4' },
      repos: unsettled,
      models: settled,
    });
    expect(note).toBeNull();
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

  it('returns null when requested + settled + matched', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo', model: 'anthropic/claude-sonnet-4' },
      repos: matched,
      models: matched,
    });
    expect(note).toBeNull();
  });

  it('returns null when only repo requested + settled + matched', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', repo: 'owner/repo' },
      repos: matched,
      models: unsettled,
    });
    expect(note).toBeNull();
  });

  it('returns null when only model requested + settled + matched', () => {
    const note = describePrefillFallback({
      prefill: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
      repos: unsettled,
      models: matched,
    });
    expect(note).toBeNull();
  });
});
