import { markdownToSlackMrkdwn } from './markdownToSlackMrkdwn';

describe('markdownToSlackMrkdwn', () => {
  describe('link conversion', () => {
    it('converts markdown links to Slack format', () => {
      expect(markdownToSlackMrkdwn('[Click here](https://example.com)')).toBe(
        '<https://example.com|Click here>'
      );
    });

    it('handles multiple links in same text', () => {
      const input = 'Check [Google](https://google.com) and [GitHub](https://github.com)';
      const expected = 'Check <https://google.com|Google> and <https://github.com|GitHub>';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('preserves text around links', () => {
      const input = 'Before [link](https://example.com) after';
      const expected = 'Before <https://example.com|link> after';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });

  describe('bold conversion', () => {
    it('converts double asterisk bold to Slack format', () => {
      expect(markdownToSlackMrkdwn('**bold text**')).toBe('*bold text*');
    });

    it('wraps bold URLs in angle brackets to prevent Slack from including trailing * in URL', () => {
      expect(markdownToSlackMrkdwn('**https://google.com**')).toBe('*<https://google.com>*');
    });

    it('handles multiple bold sections', () => {
      const input = '**first** and **second**';
      const expected = '*first* and *second*';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });

  describe('italic conversion', () => {
    it('converts double underscore italic to Slack format', () => {
      expect(markdownToSlackMrkdwn('__italic text__')).toBe('_italic text_');
    });

    it('wraps italic URLs in angle brackets to prevent Slack from including trailing _ in URL', () => {
      expect(markdownToSlackMrkdwn('__https://example.com/path__')).toBe(
        '_<https://example.com/path>_'
      );
    });

    it('handles multiple italic sections', () => {
      const input = '__first__ and __second__';
      const expected = '_first_ and _second_';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });

  describe('heading conversion', () => {
    it('converts h1 headings to bold', () => {
      expect(markdownToSlackMrkdwn('# Heading 1')).toBe('*Heading 1*');
    });

    it('converts h2 headings to bold', () => {
      expect(markdownToSlackMrkdwn('## Heading 2')).toBe('*Heading 2*');
    });

    it('converts h3 headings to bold', () => {
      expect(markdownToSlackMrkdwn('### Heading 3')).toBe('*Heading 3*');
    });

    it('handles multiple headings in multiline text', () => {
      const input = '# First\nSome text\n## Second';
      const expected = '*First*\nSome text\n*Second*';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('only converts headings at start of line', () => {
      const input = 'Not a # heading';
      expect(markdownToSlackMrkdwn(input)).toBe('Not a # heading');
    });
  });

  describe('combined conversions', () => {
    it('handles bold and links together', () => {
      const input = '**Check out** [this link](https://example.com)';
      const expected = '*Check out* <https://example.com|this link>';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('handles headings with bold content', () => {
      const input = '# **Important** Heading';
      // Bold is converted first: # *Important* Heading
      // Then heading wraps whole line: **Important* Heading*
      const expected = '**Important* Heading*';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('handles complex mixed content', () => {
      const input = `# Welcome
Here is **important** info.
Check [our docs](https://docs.example.com) for more.
## Next Steps
Use __this__ feature.`;
      const expected = `*Welcome*
Here is *important* info.
Check <https://docs.example.com|our docs> for more.
*Next Steps*
Use _this_ feature.`;
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('handles mixed bold and italics', () => {
      const input = '**bold** and __italic__';
      const expected = '*bold* and _italic_';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(markdownToSlackMrkdwn('')).toBe('');
    });

    it('returns plain text unchanged', () => {
      const input = 'Just plain text without any markdown';
      expect(markdownToSlackMrkdwn(input)).toBe(input);
    });

    it('preserves single asterisks (italic in markdown)', () => {
      const input = '*italic text*';
      expect(markdownToSlackMrkdwn(input)).toBe('*italic text*');
    });

    it('properly handles URLs inside bold strings', () => {
      const input = '*for more information go to http://example.org/*';
      expect(markdownToSlackMrkdwn(input)).toBe(
        '*for more information go to <http://example.org/>*'
      );
    });

    it('handles formatted URLs inside bold strings', () => {
      const input = '**[http://example.org](example.org)**';
      expect(markdownToSlackMrkdwn(input)).toBe('*<http://example.org|example.org>*');
    });

    it('preserves single underscores', () => {
      const input = '_italic text_';
      expect(markdownToSlackMrkdwn(input)).toBe('_italic text_');
    });

    it('properly handles URLs inside italic strings', () => {
      const input = '_for more information go to http://example.org/_';
      expect(markdownToSlackMrkdwn(input)).toBe(
        '_for more information go to <http://example.org/>_'
      );
    });

    it('handles multiple formatted URLs inside of a bold string', () => {
      const input = '**[http://example.org](example.org) and [http://example.com](example.com)**';
      expect(markdownToSlackMrkdwn(input)).toBe(
        '*<http://example.org|example.org> and <http://example.com|example.com>*'
      );
    });

    it('handles multiple URLs inside of a bold string', () => {
      const input = '**http://example.org and http://example.com**';
      expect(markdownToSlackMrkdwn(input)).toBe('*<http://example.org> and <http://example.com>*');
    });

    it('handles a mix of multiple formatted/non-formatted URLs inside of a bold string', () => {
      const input = '**http://example.org and [http://example.com](example.com)**';
      expect(markdownToSlackMrkdwn(input)).toBe(
        '*<http://example.org> and <http://example.com|example.com>*'
      );
    });

    it('handles newlines correctly', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      expect(markdownToSlackMrkdwn(input)).toBe('Line 1\nLine 2\nLine 3');
    });
  });
});
