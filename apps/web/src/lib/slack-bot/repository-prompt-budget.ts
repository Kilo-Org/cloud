/**
 * Most repository entries one prompt block lists.
 *
 * This bounds the prompt block only. Collectors, repository resolution, and
 * the stored inventory keep the full set, so a repository outside the listed
 * subset still resolves normally.
 */
export const REPOSITORY_PROMPT_MAX_REPOSITORIES = 50;

/**
 * Most characters one prompt block may occupy, counted across the listed
 * entries and the overflow line that stands in for the rest.
 */
export const REPOSITORY_PROMPT_MAX_CHARACTERS = 4000;

/**
 * Render repository entries as one prompt block.
 *
 * Entries are taken in order while the count stays at or under
 * {@link REPOSITORY_PROMPT_MAX_REPOSITORIES} and the block stays at or under
 * {@link REPOSITORY_PROMPT_MAX_CHARACTERS} once the overflow line for the
 * remaining entries is added. The first entry that would break either bound
 * ends the list. When entries remain, exactly one overflow line follows them,
 * produced by `formatOverflowLine` from the number of omitted entries, and
 * tells the model to ask the user for the exact path. With nothing omitted the
 * result is the entries joined by newlines, unchanged.
 */
export function renderBoundedRepositoryList(
  lines: readonly string[],
  formatOverflowLine: (omittedCount: number) => string
): string {
  const total = lines.length;
  const countCap = Math.min(total, REPOSITORY_PROMPT_MAX_REPOSITORIES);
  let included = 0;
  let includedLength = 0;

  while (included < countCap) {
    const candidateLength =
      included === 0 ? lines[0].length : includedLength + 1 + lines[included].length;
    const omitted = total - included - 1;
    const candidateTotal =
      omitted > 0 ? candidateLength + 1 + formatOverflowLine(omitted).length : candidateLength;
    if (candidateTotal > REPOSITORY_PROMPT_MAX_CHARACTERS) break;
    includedLength = candidateLength;
    included += 1;
  }

  if (included === total) return lines.join('\n');

  const omitted = total - included;
  const overflowLine = formatOverflowLine(omitted);
  if (included === 0) return overflowLine;
  return `${lines.slice(0, included).join('\n')}\n${overflowLine}`;
}
