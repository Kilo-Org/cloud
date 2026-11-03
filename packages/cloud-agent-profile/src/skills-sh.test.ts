import { describe, expect, test } from 'vitest';
import { parseSkillsShSource, parseSkillsShSourceUrl, skillsShInputSchema } from './skills-sh';

const canonical = {
  owner: 'owner',
  repo: 'repo',
  skill: 'deploy',
  ownerRepo: 'owner/repo',
  sourceUrl: 'https://skills.sh/owner/repo/deploy',
};

describe('skillsShInputSchema normalization', () => {
  test.each([
    'owner/repo@deploy',
    'owner/repo/deploy',
    'https://skills.sh/owner/repo/deploy',
    'https://www.skills.sh/owner/repo/deploy',
    'https://skills.sh/owner/repo/deploy/',
    '  HTTPS://WWW.SKILLS.SH/Owner/Repo/deploy  ',
  ])('normalizes %s to the canonical reference', source => {
    expect(skillsShInputSchema.parse({ source })).toEqual({ source: canonical });
  });

  test('normalizes a dot-containing repository name and preserves enabled', () => {
    const parsed = skillsShInputSchema.parse({
      source: 'Kilo-Org/kilo.code@review-code',
      enabled: false,
    });

    expect(parsed).toEqual({
      source: {
        owner: 'kilo-org',
        repo: 'kilo.code',
        skill: 'review-code',
        ownerRepo: 'kilo-org/kilo.code',
        sourceUrl: 'https://skills.sh/kilo-org/kilo.code/review-code',
      },
      enabled: false,
    });
  });

  test('parseSkillsShSourceUrl rejects non-canonical stored URLs', () => {
    expect(parseSkillsShSourceUrl('https://skills.sh/owner/repo/deploy')).toEqual(canonical);
    expect(parseSkillsShSourceUrl('https://www.skills.sh/owner/repo/deploy')).toBeNull();
    expect(parseSkillsShSourceUrl('https://skills.sh/owner/repo/deploy/')).toBeNull();
  });
});

describe('skillsShInputSchema unsafe input rejection', () => {
  test.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['http scheme', 'http://skills.sh/owner/repo/deploy'],
    ['arbitrary host', 'https://evil.example/owner/repo/deploy'],
    ['lookalike host', 'https://skills.sh.evil.example/owner/repo/deploy'],
    ['userinfo host', 'https://skills.sh@evil.example/owner/repo/deploy'],
    ['credentials', 'https://user:pass@skills.sh/owner/repo/deploy'],
    ['port', 'https://skills.sh:8443/owner/repo/deploy'],
    ['query', 'https://skills.sh/owner/repo/deploy?ref=main'],
    ['fragment', 'https://skills.sh/owner/repo/deploy#readme'],
    ['encoded path', 'https://skills.sh/owner/re%70o/deploy'],
    ['encoded traversal', 'https://skills.sh/owner/%2e%2e/deploy'],
    ['url traversal', 'https://skills.sh/owner/../deploy'],
    ['qualified traversal', 'owner/../repo@deploy'],
    ['skill traversal', 'owner/repo@../deploy'],
    ['double-dot repo', 'owner/re..po@deploy'],
    ['option source', '-owner/repo@deploy'],
    ['option skill', 'owner/repo@--force'],
    ['option repo', 'owner/-repo@deploy'],
    ['missing skill', 'owner/repo'],
    ['missing qualified repo', 'owner@deploy'],
    ['extra qualified path', 'owner/repo@deploy/extra'],
    ['extra slash path', 'owner/repo/deploy/extra'],
    ['double slash', 'owner//deploy'],
    ['empty skill', 'owner/repo@'],
    ['empty owner', '/repo@deploy'],
    ['multiple at signs', 'owner/repo@@deploy'],
    ['uppercase skill', 'owner/repo@Deploy'],
    ['uppercase invalid slug', 'owner/repo@deploy_script'],
    ['space in skill', 'owner/repo@deploy script'],
    ['backslash', 'owner\\repo@deploy'],
    ['other scheme', 'ftp://skills.sh/owner/repo/deploy'],
    ['unsupported host www2', 'https://www2.skills.sh/owner/repo/deploy'],
  ])('rejects %s', (_name, source) => {
    expect(skillsShInputSchema.safeParse({ source }).success).toBe(false);
    expect(parseSkillsShSource(source)).toBeNull();
  });
});
