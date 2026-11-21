import { ReviewGuidelineSourceRepositoriesSchema } from '@kilocode/db/schema-types';

const MAX_GUIDELINE_SOURCE_REPOSITORIES = 100;

export function parseGuidelineSourceRepositories(
  input: string
): { success: true; data: string[] } | { success: false; error: string } {
  const values = input
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length > MAX_GUIDELINE_SOURCE_REPOSITORIES) {
    return {
      success: false,
      error: `You entered ${values.length} repositories. Remove entries until there are ${MAX_GUIDELINE_SOURCE_REPOSITORIES} or fewer.`,
    };
  }
  const parsed = ReviewGuidelineSourceRepositoriesSchema.safeParse(values);
  if (parsed.success) return { success: true, data: parsed.data };
  const index = parsed.error.issues.find(issue => typeof issue.path[0] === 'number')?.path[0];
  const invalid = typeof index === 'number' ? values[index] : undefined;
  if (!invalid) {
    return {
      success: false,
      error: 'Enter one owner/repo per line, for example acme/review-guidelines.',
    };
  }
  const shown = invalid.length > 80 ? `${invalid.slice(0, 80)}…` : invalid;
  return {
    success: false,
    error: `"${shown}" is not a valid repository. Use owner/repo, for example acme/review-guidelines.`,
  };
}
