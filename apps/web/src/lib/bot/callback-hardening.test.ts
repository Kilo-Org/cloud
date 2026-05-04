import {
  buildCallbackThreadPostChunks,
  formatCallbackContinuationFailureMessage,
  getCallbackErrorMessage,
} from '@/lib/bot/callback-hardening';

describe('bot callback hardening', () => {
  it('keeps ordinary callback messages as a single raw text post', () => {
    const chunks = buildCallbackThreadPostChunks('Cloud Agent result with **markdown**');

    expect(chunks).toEqual(['Cloud Agent result with **markdown**']);
  });

  it('splits very large callback messages into Slack-sized raw text posts', () => {
    const longMessage = `${'a'.repeat(20_000)}\n\n${'b'.repeat(20_000)}\n\n${'c'.repeat(20_000)}`;
    const chunks = buildCallbackThreadPostChunks(longMessage);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('a'.repeat(20_000));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(39_000);
    }
  });

  it('formats credit-related callback continuation failures as user-actionable terminal messages', () => {
    expect(
      formatCallbackContinuationFailureMessage(
        new Error('AI gateway returned 402: insufficient credits')
      )
    ).toBe(
      'Cloud Agent finished, but Kilo Bot could not continue because credits are required. Add credits to continue, then send a new message if more work is needed.'
    );
  });

  it('formats non-credit callback continuation failures with bounded detail', () => {
    const message = formatCallbackContinuationFailureMessage(new Error('upstream timeout'));

    expect(message).toBe(
      'Cloud Agent finished, but Kilo Bot could not continue after the callback: upstream timeout'
    );
  });

  it('normalizes non-error thrown values', () => {
    expect(getCallbackErrorMessage({ message: 'plain object failure' })).toBe(
      '{"message":"plain object failure"}'
    );
  });
});
