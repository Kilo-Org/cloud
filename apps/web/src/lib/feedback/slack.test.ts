import { feedbackPlainTextBlocks } from './slack';

describe('feedbackPlainTextBlocks', () => {
  it('keeps links, mentions, Markdown, emoji codes and entities as literal plain text', () => {
    const text =
      '``` <!channel> <!here> <@U123> <https://attacker.invalid|review> :smile: &lt;test&gt;';
    expect(feedbackPlainTextBlocks(text)).toEqual([
      { type: 'section', text: { type: 'plain_text', text, emoji: false } },
    ]);
  });

  it.each([3_000, 3_001, 10_000, 40_000])(
    'preserves all %i characters within section limits',
    length => {
      const text = 'feedback\n'.repeat(Math.ceil(length / 9)).slice(0, length);
      const blocks = feedbackPlainTextBlocks(text);

      expect(blocks.map(block => block.text?.text).join('')).toBe(text);
      expect(blocks.length).toBeLessThanOrEqual(50);
      for (const block of blocks) {
        expect(block.text).toMatchObject({ type: 'plain_text', emoji: false });
        expect(block.text?.text.length).toBeLessThanOrEqual(3_000);
      }
    }
  );

  it('does not split surrogate pairs between blocks', () => {
    const text = 'x'.repeat(2_999) + '\uD83D\uDE00' + 'trailing text';
    const blocks = feedbackPlainTextBlocks(text);

    expect(blocks[0].text?.text).toBe('x'.repeat(2_999));
    expect(blocks[1].text?.text).toBe('\uD83D\uDE00trailing text');
    expect(blocks.map(block => block.text?.text).join('')).toBe(text);
  });

  it('bounds oversized previews and indicates that the full submission is stored', () => {
    const notice = '\n[Slack preview truncated; full feedback is stored.]';
    const text = 'x'.repeat(40_000 - notice.length - 1) + '\uD83D\uDE00' + 'x'.repeat(10_000);
    const blocks = feedbackPlainTextBlocks(text);
    const preview = blocks.map(block => block.text?.text).join('');

    expect(preview.length).toBeLessThanOrEqual(40_000);
    expect(preview).toContain('[Slack preview truncated; full feedback is stored.]');
    expect(preview.isWellFormed()).toBe(true);
    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const block of blocks) {
      expect(block.text?.text.length).toBeLessThanOrEqual(3_000);
    }
  });
});
