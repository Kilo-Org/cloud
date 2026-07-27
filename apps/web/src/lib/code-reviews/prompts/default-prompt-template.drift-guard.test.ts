/**
 * Drift-guard test: the prompt-template footer literally tells users
 * "Reply with `@kilocode-bot fix it` to have Kilo Code address this
 * issue", and the auto-fix webhook processor is supposed to admit
 * exactly that command. This test reads the JSON footer literal
 * verbatim, asserts the footer still contains the advertised command
 * string, and asserts the shared `parseFixCommand` parser admits it.
 *
 * Placement: this test lives in apps/web (not in @kilocode/app-shared)
 * because the shared package cannot import a JSON file that lives in
 * apps/web, while apps/web can import both the template JSON and the
 * shared parser. Co-locating the footer literal and the parser
 * assertion in the same test makes any future divergence — a footer
 * wording change, a parser narrowing, or a mention-pattern
 * simplification that re-breaks the advertised command — fail
 * immediately.
 */
import defaultPromptTemplate from './default-prompt-template.json';
import { parseFixCommand } from '@kilocode/app-shared/code-review';

const ADVERTISED_COMMAND = '@kilocode-bot fix it';

describe('default-prompt-template inlineCommentFooter drift guard', () => {
  const footer = defaultPromptTemplate.inlineCommentFooter;

  it('still advertises the exact @kilocode-bot fix it command', () => {
    expect(footer).toContain(ADVERTISED_COMMAND);
  });

  it('the shared parseFixCommand admits the exact advertised command', () => {
    expect(parseFixCommand(ADVERTISED_COMMAND)).toBe(true);
  });

  it('parseFixCommand also admits a representative command embedded in the footer text', () => {
    // Sanity check: extracting a representative admit-command from the
    // footer literal and running it through the parser must still admit.
    // If both the footer wording and the parser ever drift, this fails.
    const sample = footer.split('\n').find(line => line.includes('@kilocode-bot'));
    expect(sample).toBeDefined();
    expect(parseFixCommand(sample!)).toBe(true);
  });
});
