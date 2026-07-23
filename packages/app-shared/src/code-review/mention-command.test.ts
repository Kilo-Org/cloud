import { describe, expect, it } from 'vitest';

import { parseFixCommand } from './mention-command';

describe('parseFixCommand', () => {
  describe('admits', () => {
    it('admits the product-advertised @kilocode-bot fix it command', () => {
      // The exact command string the inlineCommentFooter in
      // apps/web/src/lib/code-reviews/prompts/default-prompt-template.json
      // asks users to reply with. Regression guard: the previous
      // /@kilo\b/i pattern rejected this because \b does not match
      // between letters of "kilocode".
      expect(parseFixCommand('@kilocode-bot fix it')).toBe(true);
    });

    it('admits the existing shorthand @kilo please fix', () => {
      expect(parseFixCommand('@kilo please fix')).toBe(true);
    });

    it('admits the existing shorthand @kilo patch this', () => {
      expect(parseFixCommand('@kilo patch this')).toBe(true);
    });

    it('admits @kilocode (no -bot suffix) with a fix keyword', () => {
      expect(parseFixCommand('@kilocode can you fix this?')).toBe(true);
    });

    it('is case-insensitive for both mention and fix keyword', () => {
      expect(parseFixCommand('@KiloCode-Bot FIX it')).toBe(true);
      expect(parseFixCommand('@KILO Patch this')).toBe(true);
    });

    it('admits when the mention and fix keyword appear in either order', () => {
      expect(parseFixCommand('Please fix this @kilocode-bot thanks')).toBe(true);
    });
  });

  describe('rejects', () => {
    it('rejects a mention without a fix keyword', () => {
      expect(parseFixCommand('@kilocode-bot ship it')).toBe(false);
      expect(parseFixCommand('@kilo ship it')).toBe(false);
    });

    it('rejects a fix keyword without a mention', () => {
      expect(parseFixCommand('please fix this')).toBe(false);
      expect(parseFixCommand('patch this thing')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(parseFixCommand('')).toBe(false);
    });

    it('rejects unrelated text', () => {
      expect(parseFixCommand('Looks good to me!')).toBe(false);
      expect(parseFixCommand('LGTM, merging.')).toBe(false);
    });
  });
});
