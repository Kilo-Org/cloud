import {
  fetchGitHubRepositoryDefaultBranchSha,
  fetchGitHubRootTextFileAtRef,
} from '@/lib/integrations/platforms/github/adapter';
import { resolveReviewGuidelines } from './resolve-review-guidelines';

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubRepositoryDefaultBranchSha: jest.fn(),
  fetchGitHubRootTextFileAtRef: jest.fn(),
}));

const fetchSha = jest.mocked(fetchGitHubRepositoryDefaultBranchSha);
const fetchFile = jest.mocked(fetchGitHubRootTextFileAtRef);
const SHA = 'a'.repeat(40);
const defaults = {
  platform: 'github',
  repository: 'acme/app',
  baseRef: 'release',
  allowedRepositories: ['acme/guidelines'],
  githubToken: 'synthetic-token',
} as const;

function review(entries: unknown[], body = 'Repository rules.'): string {
  return `---\nextends: ${JSON.stringify(entries)}\n---\n${body}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchSha.mockResolvedValue(SHA);
  fetchFile.mockResolvedValue('Shared rules.');
});

it('parses YAML lists and inline lists, strips front matter, and preserves order', async () => {
  fetchFile.mockImplementation(async ({ path }) =>
    path === 'frontend.md' ? 'Frontend rules.' : 'Backend rules.'
  );
  for (const rawContent of [
    '---\nextends:\n  - acme/guidelines:frontend.md\n  - acme/guidelines:backend/api.md\n---\nRepository rules.',
    review(['acme/guidelines:frontend.md', 'acme/guidelines:backend/api.md']),
  ]) {
    const result = await resolveReviewGuidelines({ ...defaults, rawContent });
    expect(result.imports.map(entry => entry.status)).toEqual(['imported', 'imported']);
    expect(result.content).not.toContain('extends:');
    expect(result.content?.indexOf('Frontend rules.')).toBeLessThan(
      result.content?.indexOf('Backend rules.') ?? 0
    );
    expect(result.content?.indexOf('Backend rules.')).toBeLessThan(
      result.content?.indexOf('Repository rules.') ?? 0
    );
    expect(result.content).toContain('acme/guidelines:backend/api.md');
    expect(result.content).toContain('acme/app:REVIEW.md');
    expect(result.content).toContain('The repository text wins on conflict.');
  }
});

it.each([
  'https://example.com/policy.md',
  'acme/guidelines:/policy.md',
  'acme/guidelines:../policy.md',
  'acme/guidelines:a/../policy.md',
  'acme/guidelines:a\\policy.md',
  'acme/guidelines:policy.MD',
  'acme/guidelines:policy.txt',
  'acme/guidelines:',
  'acme/guidelines',
  'acme/guidelines:C:/policy.md',
  'acme/guidelines:https://example.com/policy.md',
  42,
  null,
  { source: 'acme/guidelines:policy.md' },
])('rejects invalid entry %j before any fetch', async entry => {
  const result = await resolveReviewGuidelines({ ...defaults, rawContent: review([entry]) });
  expect(result.imports[0].status).toBe('invalid');
  expect(fetchSha).not.toHaveBeenCalled();
  expect(fetchFile).not.toHaveBeenCalled();
});

it('checks the allowlist before any fetch', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/other:policy.md']),
  });
  expect(result.imports).toEqual([
    { source: 'acme/other:policy.md', sha: null, status: 'not_allowed' },
  ]);
  expect(fetchSha).not.toHaveBeenCalled();
  expect(fetchFile).not.toHaveBeenCalled();
});

it('matches repositories without case sensitivity, but preserves path case', async () => {
  await resolveReviewGuidelines({ ...defaults, rawContent: review(['ACME/Guidelines:Policy.md']) });
  expect(fetchFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'Policy.md' }));
});

it('rejects self-imports distinctly, even when allowlisted', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    allowedRepositories: ['ACME/APP'],
    rawContent: review(['ACME/APP:policy.md']),
  });
  expect(result.imports[0].status).toBe('self_import');
  expect(fetchSha).not.toHaveBeenCalled();
});

it('does not fetch sources from another installation owner', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    allowedRepositories: ['other/guidelines'],
    rawContent: review(['other/guidelines:policy.md']),
  });
  expect(result.imports[0].status).toBe('not_accessible');
  expect(fetchSha).not.toHaveBeenCalled();
});

it('records missing files and directories without losing other entries', async () => {
  fetchFile
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('Present rules.');
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review([
      'acme/guidelines:missing.md',
      'acme/guidelines:directory.md',
      'acme/guidelines:present.md',
    ]),
  });
  expect(result.imports.map(entry => entry.status)).toEqual(['not_found', 'not_found', 'imported']);
  expect(result.imports.every(entry => entry.sha === SHA)).toBe(true);
  expect(result.content).toContain('Present rules.');
});

it.each([401, 403, 404])('records inaccessible source repositories for HTTP %i', async status => {
  fetchSha.mockRejectedValue({ status });
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:policy.md']),
  });
  expect(result.imports[0]).toMatchObject({ sha: null, status: 'not_accessible' });
  expect(fetchFile).not.toHaveBeenCalled();
  expect(result.content).toContain('Repository rules.');
});

it('keeps the resolved SHA when a file becomes inaccessible', async () => {
  fetchFile.mockRejectedValue({ status: 403 });
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:policy.md']),
  });
  expect(result.imports[0]).toMatchObject({ sha: SHA, status: 'not_accessible' });
});

it('continues after an unexpected fetch error', async () => {
  fetchFile.mockRejectedValueOnce(new Error('network unavailable'));
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:a.md', 'acme/guidelines:b.md']),
  });
  expect(result.imports.map(entry => entry.status)).toEqual(['fetch_error', 'imported']);
});

it('limits imports to ten and records every extra entry', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(Array.from({ length: 12 }, (_, index) => `acme/guidelines:${index}.md`)),
  });
  expect(fetchFile).toHaveBeenCalledTimes(10);
  expect(result.imports.map(entry => entry.status)).toEqual([
    ...Array(10).fill('imported'),
    'entry_limit',
    'entry_limit',
  ]);
});

it('pins every file from one source repository to one SHA lookup', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:a.md', 'ACME/GUIDELINES:b.md']),
  });
  expect(fetchSha).toHaveBeenCalledTimes(1);
  expect(fetchFile).toHaveBeenCalledTimes(2);
  expect(fetchFile.mock.calls.every(([params]) => params.ref === SHA)).toBe(true);
  expect(result.imports.map(entry => entry.sha)).toEqual([SHA, SHA]);
});

it('bounds parallel source and file fetches to three', async () => {
  let active = 0;
  let peak = 0;
  const observe = async () => {
    active++;
    peak = Math.max(active, peak);
    await Promise.resolve();
    active--;
    return SHA;
  };
  fetchSha.mockImplementation(observe);
  fetchFile.mockImplementation(observe);
  const repositories = Array.from({ length: 10 }, (_, index) => `acme/source-${index}`);
  await resolveReviewGuidelines({
    ...defaults,
    allowedRepositories: repositories,
    rawContent: review(repositories.map(repository => `${repository}:policy.md`)),
  });
  expect(peak).toBe(3);
});

it('drops imports from the end before cutting repository text', async () => {
  fetchFile.mockImplementation(async ({ path }) => `${path}\n${'x'.repeat(6_000)}`);
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(
      ['acme/guidelines:first.md', 'acme/guidelines:second.md', 'acme/guidelines:last.md'],
      'Repository rules.\n' + 'r'.repeat(8_000)
    ),
  });
  expect(result.content?.length).toBeLessThanOrEqual(20_000);
  expect(result.imports.map(entry => entry.status)).toEqual([
    'imported',
    'dropped_budget',
    'dropped_budget',
  ]);
  expect(result.content).toContain('r'.repeat(8_000));
  expect(result.truncated).toBe(true);
});

it('cuts oversized repository text only after dropping all imports', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:a.md'], 'r'.repeat(25_000)),
  });
  expect(result.content).toHaveLength(20_000);
  expect(result.imports[0].status).toBe('dropped_budget');
  expect(result.content).toContain('[REVIEW.md truncated after 20000 characters.]');
  expect(result.truncated).toBe(true);
});

it('strips imported front matter without resolving nested imports', async () => {
  fetchFile.mockResolvedValue(
    '---\nextends: [acme/guidelines:nested.md]\nother: ignored\n---\nImported rules.'
  );
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:a.md']),
  });
  expect(fetchFile).toHaveBeenCalledTimes(1);
  expect(result.content).toContain('Imported rules.');
  expect(result.content).not.toContain('nested.md');
  expect(result.content).not.toContain('other:');
});

it.each(['gitlab', 'bitbucket'] as const)('does not fetch imports for %s', async platform => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    platform,
    rawContent: review(['acme/guidelines:a.md']),
  });
  expect(result.imports[0].status).toBe('unsupported_platform');
  expect(result.content).toContain('Repository rules.');
  expect(result.content).not.toContain('extends:');
  expect(fetchSha).not.toHaveBeenCalled();
  expect(fetchFile).not.toHaveBeenCalled();
});

it('preserves plain markdown and removes unrelated front matter', async () => {
  for (const rawContent of [
    '\r\n# Rules\r\n\r\nText.\r\n',
    '---\ntitle: Guidelines\n---\n# Rules\n\nText.',
    '---\n---\n# Rules\n\nText.',
  ]) {
    const result = await resolveReviewGuidelines({ ...defaults, rawContent });
    expect(result.content).toBe('# Rules\n\nText.');
    expect(result.imports).toEqual([]);
  }
});

it('falls back to default guidance when all imports fail and the repository body is empty', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    allowedRepositories: [],
    rawContent: review(['acme/guidelines:a.md'], ''),
  });
  expect(result.used).toBe(false);
  expect(result.imports[0].status).toBe('not_allowed');
});

it('records malformed YAML and retains the repository body', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: '---\nextends: [invalid\n---\nLocal rules.',
  });
  expect(result.imports[0].status).toBe('invalid');
  expect(result.content).toContain('Local rules.');
  expect(result.content).not.toContain('extends:');
});

it('requires extends to be a list', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: '---\nextends: acme/guidelines:a.md\n---\nLocal rules.',
  });
  expect(result.imports[0].status).toBe('invalid');
  expect(fetchSha).not.toHaveBeenCalled();
});

it('accepts relative dot segments and splits only on the first colon', async () => {
  await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:./guides/policy:api.md']),
  });
  expect(fetchFile).toHaveBeenCalledWith(
    expect.objectContaining({ path: './guides/policy:api.md' })
  );
});

it('uses imported rules even if the repository body is empty', async () => {
  const result = await resolveReviewGuidelines({
    ...defaults,
    rawContent: review(['acme/guidelines:a.md'], ''),
  });
  expect(result.used).toBe(true);
  expect(result.content).toContain('Shared rules.');
});

it.each([null, '', '---\ntitle: empty\n---\n'])(
  'falls back when no guideline text exists: %j',
  async rawContent => {
    const result = await resolveReviewGuidelines({ ...defaults, rawContent });
    expect(result.used).toBe(false);
    expect(result.content).toBeNull();
  }
);
