import { parseGuidelineSourceRepositories } from './guideline-source-repositories';

describe('parseGuidelineSourceRepositories', () => {
  it('trims lines and ignores blank lines', () => {
    expect(parseGuidelineSourceRepositories(' acme/guidelines \n\nacme/policies\n')).toEqual({
      success: true,
      data: ['acme/guidelines', 'acme/policies'],
    });
  });

  it('accepts an empty list', () => {
    expect(parseGuidelineSourceRepositories('  \n')).toEqual({ success: true, data: [] });
  });

  it('names the first invalid entry', () => {
    expect(
      parseGuidelineSourceRepositories('acme/guidelines\n\nhttps://github.com/acme/x\nacme')
    ).toEqual({
      success: false,
      error:
        '"https://github.com/acme/x" is not a valid repository. Use owner/repo, for example acme/review-guidelines.',
    });
  });

  it('shortens a long invalid entry', () => {
    const result = parseGuidelineSourceRepositories(`acme/${'x'.repeat(200)}`);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain(`"acme/${'x'.repeat(75)}…"`);
  });

  it('reports the entry count when there are too many repositories', () => {
    const input = Array.from({ length: 101 }, (_, index) => `acme/repo-${index}`).join('\n');
    expect(parseGuidelineSourceRepositories(input)).toEqual({
      success: false,
      error: 'You entered 101 repositories. Remove entries until there are 100 or fewer.',
    });
  });
});
