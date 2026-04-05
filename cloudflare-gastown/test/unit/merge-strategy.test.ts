import { describe, it, expect } from 'vitest';
import { TownConfigSchema, TownConfigUpdateSchema, MergeStrategy } from '../../src/types';
import { resolveMergeStrategy } from '../../src/dos/town/config';
import { parseGitUrl, buildPRBody, type QualityGateResult } from '../../src/util/platform-pr.util';

describe('merge strategy', () => {
  describe('TownConfigSchema merge_strategy field', () => {
    it('defaults to "direct" when not specified', () => {
      const config = TownConfigSchema.parse({});
      expect(config.merge_strategy).toBe('direct');
    });

    it('accepts "direct" as a valid value', () => {
      const config = TownConfigSchema.parse({ merge_strategy: 'direct' });
      expect(config.merge_strategy).toBe('direct');
    });

    it('accepts "pr" as a valid value', () => {
      const config = TownConfigSchema.parse({ merge_strategy: 'pr' });
      expect(config.merge_strategy).toBe('pr');
    });

    it('rejects invalid merge_strategy values', () => {
      expect(() => TownConfigSchema.parse({ merge_strategy: 'rebase' })).toThrow();
    });

    it('preserves merge_strategy through TownConfigSchema.partial()', () => {
      const partial = TownConfigSchema.partial().parse({ merge_strategy: 'pr' });
      expect(partial.merge_strategy).toBe('pr');
    });
  });

  describe('TownConfigUpdateSchema', () => {
    it('does not inject merge_strategy default on empty input', () => {
      const update = TownConfigUpdateSchema.parse({});
      expect(update.merge_strategy).toBeUndefined();
    });

    it('preserves merge_strategy when explicitly provided', () => {
      const update = TownConfigUpdateSchema.parse({ merge_strategy: 'pr' });
      expect(update.merge_strategy).toBe('pr');
    });

    it('does not inject any defaults on empty input', () => {
      const update = TownConfigUpdateSchema.parse({});
      // All fields should be undefined — no phantom defaults
      expect(Object.values(update).every(v => v === undefined)).toBe(true);
    });
  });

  describe('MergeStrategy enum', () => {
    it('parses "direct"', () => {
      expect(MergeStrategy.parse('direct')).toBe('direct');
    });

    it('parses "pr"', () => {
      expect(MergeStrategy.parse('pr')).toBe('pr');
    });

    it('rejects invalid values', () => {
      expect(() => MergeStrategy.parse('squash')).toThrow();
    });
  });

  describe('resolveMergeStrategy', () => {
    const townConfig = (strategy: 'direct' | 'pr') =>
      TownConfigSchema.parse({ merge_strategy: strategy });

    it('returns town config strategy when rig override is undefined', () => {
      expect(resolveMergeStrategy(townConfig('direct'), undefined)).toBe('direct');
      expect(resolveMergeStrategy(townConfig('pr'), undefined)).toBe('pr');
    });

    it('returns rig override when set', () => {
      expect(resolveMergeStrategy(townConfig('direct'), 'pr')).toBe('pr');
      expect(resolveMergeStrategy(townConfig('pr'), 'direct')).toBe('direct');
    });

    it('rig override takes precedence over town default', () => {
      const config = townConfig('direct');
      expect(resolveMergeStrategy(config, 'pr')).toBe('pr');
    });
  });
});

describe('parseGitUrl', () => {
  it('parses GitHub HTTPS URLs', () => {
    const result = parseGitUrl('https://github.com/org/repo.git');
    expect(result).toEqual({ platform: 'github', owner: 'org', repo: 'repo' });
  });

  it('parses GitHub HTTPS URLs without .git suffix', () => {
    const result = parseGitUrl('https://github.com/org/repo');
    expect(result).toEqual({ platform: 'github', owner: 'org', repo: 'repo' });
  });

  it('parses GitHub SSH URLs', () => {
    const result = parseGitUrl('git@github.com:org/repo.git');
    expect(result).toEqual({ platform: 'github', owner: 'org', repo: 'repo' });
  });

  it('parses GitLab.com HTTPS URLs', () => {
    const result = parseGitUrl('https://gitlab.com/group/project.git');
    expect(result).toEqual({ platform: 'gitlab', owner: 'group', repo: 'project' });
  });

  it('parses self-hosted GitLab HTTPS URLs when instance URL is provided', () => {
    const result = parseGitUrl(
      'https://gitlab.example.com/team/repo.git',
      'https://gitlab.example.com'
    );
    expect(result).toEqual({ platform: 'gitlab', owner: 'team', repo: 'repo' });
  });

  it('parses SSH URLs from gitlab.com', () => {
    const result = parseGitUrl('git@gitlab.com:team/repo.git');
    expect(result).toEqual({ platform: 'gitlab', owner: 'team', repo: 'repo' });
  });

  it('parses SSH URLs from configured gitlab instance', () => {
    const result = parseGitUrl(
      'git@gitlab.example.com:team/repo.git',
      'https://gitlab.example.com'
    );
    expect(result).toEqual({ platform: 'gitlab', owner: 'team', repo: 'repo' });
  });

  it('returns null for SSH URLs from unknown non-GitHub hosts without gitlab instance', () => {
    const result = parseGitUrl('git@bitbucket.org:team/repo.git');
    expect(result).toBeNull();
  });

  it('returns null for unrecognizable HTTPS URLs without gitlab instance', () => {
    const result = parseGitUrl('https://example.com/team/repo.git');
    expect(result).toBeNull();
  });

  it('handles GitLab subgroups in HTTPS URLs', () => {
    const result = parseGitUrl('https://gitlab.com/group/subgroup/project.git');
    expect(result).toEqual({ platform: 'gitlab', owner: 'group/subgroup', repo: 'project' });
  });

  it('handles GitLab subgroups in SSH URLs', () => {
    const result = parseGitUrl('git@gitlab.com:group/subgroup/deep/project.git');
    expect(result).toEqual({
      platform: 'gitlab',
      owner: 'group/subgroup/deep',
      repo: 'project',
    });
  });

  it('strips embedded credentials from HTTPS URLs', () => {
    const result = parseGitUrl('https://x-access-token:ghp_abc123@github.com/org/repo.git');
    expect(result).toEqual({ platform: 'github', owner: 'org', repo: 'repo' });
  });

  it('strips embedded credentials from GitLab HTTPS URLs', () => {
    const result = parseGitUrl('https://oauth2:token@gitlab.com/group/project.git');
    expect(result).toEqual({ platform: 'gitlab', owner: 'group', repo: 'project' });
  });

  it('does not false-positive on substring hostname match', () => {
    // gitlabInstanceUrl is gitlab.example.com but host is just example.com
    const result = parseGitUrl('https://example.com/team/repo.git', 'https://gitlab.example.com');
    expect(result).toBeNull();
  });

  it('handles trailing .git in all formats', () => {
    expect(parseGitUrl('https://github.com/a/b.git')?.repo).toBe('b');
    expect(parseGitUrl('https://github.com/a/b')?.repo).toBe('b');
    expect(parseGitUrl('git@github.com:a/b.git')?.repo).toBe('b');
  });
});

describe('buildPRBody', () => {
  it('generates a Markdown PR body with gate results', () => {
    const gates: QualityGateResult[] = [
      { name: 'Tests', passed: true, duration_seconds: 42 },
      { name: 'Typecheck', passed: true, duration_seconds: 8 },
      { name: 'Lint', passed: false, duration_seconds: 3 },
    ];

    const body = buildPRBody({
      sourceBeadId: 'bead-uuid-1234-5678',
      beadTitle: 'Add dark mode toggle',
      polecatName: 'Finnick',
      model: 'anthropic/claude-sonnet-4.6',
      gateResults: gates,
    });

    expect(body).toContain('## Gastown Agent Work');
    expect(body).toContain('bead-uui');
    expect(body).toContain('Add dark mode toggle');
    expect(body).toContain('Finnick');
    expect(body).toContain('anthropic/claude-sonnet-4.6');
    expect(body).toContain('| Tests | Passed | 42s |');
    expect(body).toContain('| Typecheck | Passed | 8s |');
    expect(body).toContain('| Lint | Failed | 3s |');
  });

  it('shows "no gates configured" when no gate results', () => {
    const body = buildPRBody({
      sourceBeadId: 'bead-id',
      beadTitle: 'Fix bug',
      polecatName: 'Nutkin',
      model: 'gpt-4',
      gateResults: [],
    });
    expect(body).toContain('(no gates configured)');
  });

  it('includes convoy line when convoyId is provided', () => {
    const body = buildPRBody({
      sourceBeadId: 'bead-id',
      beadTitle: 'Task',
      polecatName: 'Patch',
      model: 'model-1',
      convoyId: 'convoy-uuid-1234',
      gateResults: [],
    });
    expect(body).toContain('**Convoy**');
    expect(body).toContain('convoy-u');
  });

  it('includes diff stat when provided', () => {
    const body = buildPRBody({
      sourceBeadId: 'bead-id',
      beadTitle: 'Task',
      polecatName: 'Patch',
      model: 'model-1',
      gateResults: [],
      diffStat: ' 3 files changed, 42 insertions(+), 5 deletions(-)',
    });
    expect(body).toContain('### Changes');
    expect(body).toContain('3 files changed');
  });
});
