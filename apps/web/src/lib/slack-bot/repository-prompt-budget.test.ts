import { describe, expect, test } from '@jest/globals';
import {
  REPOSITORY_PROMPT_MAX_CHARACTERS,
  REPOSITORY_PROMPT_MAX_REPOSITORIES,
  renderBoundedRepositoryList,
} from './repository-prompt-budget';

const overflow = (omitted: number) => `- Repositories not listed here: ${omitted}`;

describe('renderBoundedRepositoryList', () => {
  test('returns the exact join when the list fits the budget', () => {
    const lines = ['- a/one [id: 1]', '- a/two [id: 2]', '- a/three [id: 3]'];

    expect(renderBoundedRepositoryList(lines, overflow)).toBe(lines.join('\n'));
  });

  test('returns an empty string for an empty list', () => {
    expect(renderBoundedRepositoryList([], overflow)).toBe('');
  });

  test('lists exactly the count cap and one overflow line over the count cap', () => {
    const lines = Array.from(
      { length: REPOSITORY_PROMPT_MAX_REPOSITORIES + 10 },
      (_, index) => `- owner/repo-${index} [id: ${index}]`
    );

    const result = renderBoundedRepositoryList(lines, overflow);
    const resultLines = result.split('\n');

    expect(resultLines).toHaveLength(REPOSITORY_PROMPT_MAX_REPOSITORIES + 1);
    expect(resultLines.slice(0, REPOSITORY_PROMPT_MAX_REPOSITORIES)).toEqual(
      lines.slice(0, REPOSITORY_PROMPT_MAX_REPOSITORIES)
    );
    expect(resultLines[REPOSITORY_PROMPT_MAX_REPOSITORIES]).toBe(overflow(10));
  });

  test('stays within the character budget and keeps the omitted count consistent', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `- ${'o'.repeat(120)}/repo-${index}`);

    const result = renderBoundedRepositoryList(lines, overflow);
    const resultLines = result.split('\n');
    const listed = resultLines.length - 1;
    const omittedMatch = /^- Repositories not listed here: (\d+)$/.exec(
      resultLines[resultLines.length - 1]
    );

    expect(result.length).toBeLessThanOrEqual(REPOSITORY_PROMPT_MAX_CHARACTERS);
    expect(omittedMatch).not.toBeNull();
    expect(listed + Number(omittedMatch?.[1])).toBe(lines.length);
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(REPOSITORY_PROMPT_MAX_REPOSITORIES);
  });

  test('renders only the overflow line when the first entry alone exceeds the budget', () => {
    const lines = [`- ${'x'.repeat(REPOSITORY_PROMPT_MAX_CHARACTERS + 100)}`];

    expect(renderBoundedRepositoryList(lines, overflow)).toBe(overflow(1));
  });
});
