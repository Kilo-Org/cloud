import { describe, expect, it } from 'vitest';
import { BRIEFING_MAX_EXCERPT_BYTES } from '@kilocode/app-shared/agent-briefing';
import {
  BRIEFING_MAX_INLINE_BYTES,
  BRIEFING_MAX_EXCERPT_SOURCE_ROWS,
  buildBriefingExcerpt,
  completedBriefingResponse,
  isFinalizedBriefingText,
} from './briefing-excerpt';

const completedAt = 1792022460000;
const message = {
  id: 'assistant',
  role: 'assistant',
  finish: 'stop',
  time: { created: completedAt - 1000, completed: completedAt },
};
const textPart = (text: string) => ({
  id: 'text',
  messageID: message.id,
  type: 'text',
  text,
  time: { start: completedAt - 1000, end: completedAt },
});

describe('completed briefing responses', () => {
  it('attributes only the completed final assistant text to its source message and time', () => {
    expect(
      buildBriefingExcerpt(message, [
        { ...textPart('reasoning secret'), type: 'reasoning' },
        {
          ...textPart('tool secret'),
          type: 'tool',
          state: { status: 'completed', output: 'secret' },
        },
        { ...textPart('user secret'), messageID: 'user' },
        { ...textPart('synthetic secret'), synthetic: true },
        { ...textPart('ignored secret'), ignored: true },
        textPart('Updated the '),
        textPart('parser.'),
      ])
    ).toEqual({
      messageId: message.id,
      completedAt: new Date(completedAt).toISOString(),
      text: 'Updated the parser.',
    });
  });

  it.each([
    { ...message, role: 'user' },
    { ...message, finish: undefined },
    { ...message, finish: 'tool-calls' },
    { ...message, finish: 'unknown' },
    { ...message, summary: true },
    { ...message, error: { name: 'APIError' } },
    { ...message, time: { created: completedAt - 1000 } },
    { ...message, time: { completed: Number.NaN } },
    { ...message, time: { completed: Number.POSITIVE_INFINITY } },
    { ...message, time: { completed: 0 } },
    { ...message, time: { completed: 1e20 } },
  ])('excludes unfinished, intermediate and non-response messages: %j', candidate => {
    expect(completedBriefingResponse(candidate)).toBeUndefined();
    expect(buildBriefingExcerpt(candidate, [textPart('not final')])).toBeUndefined();
  });

  it('does not expose a text stream before the parent response completes', () => {
    const streamingPart = { ...textPart('partial secret'), time: { start: completedAt - 1000 } };
    expect(isFinalizedBriefingText(streamingPart)).toBe(false);
    expect(buildBriefingExcerpt(message, [streamingPart])).toBeUndefined();
    expect(
      buildBriefingExcerpt({ ...message, time: { created: completedAt - 1000 } }, [
        textPart('finished part'),
      ])
    ).toBeUndefined();
    expect(
      buildBriefingExcerpt(message, [{ ...textPart('later part'), time: { end: completedAt + 1 } }])
    ).toBeUndefined();
  });

  it('accepts static completed response text without copying reasoning or structured fields', () => {
    expect(
      buildBriefingExcerpt(
        { ...message, text: 'Done.', reasoning: 'secret', structured: { secret: true } },
        []
      )?.text
    ).toBe('Done.');
    expect(buildBriefingExcerpt(message, [{ ...textPart('Done.'), time: undefined }])?.text).toBe(
      'Done.'
    );
    expect(buildBriefingExcerpt(message, [])).toBeUndefined();
  });

  it('omits over-budget raw text rather than redacting a truncated credential prefix', () => {
    expect(
      buildBriefingExcerpt(message, [textPart('token=' + 'x'.repeat(BRIEFING_MAX_INLINE_BYTES))])
    ).toBeUndefined();
    expect(
      buildBriefingExcerpt(message, [
        textPart('界'.repeat(Math.floor(BRIEFING_MAX_INLINE_BYTES / 3) + 1)),
      ])
    ).toBeUndefined();
    expect(
      buildBriefingExcerpt(message, [
        textPart('x'.repeat(BRIEFING_MAX_INLINE_BYTES / 2)),
        textPart('y'.repeat(BRIEFING_MAX_INLINE_BYTES / 2 + 1)),
      ])
    ).toBeUndefined();
  });

  it('stops examining a response after the bounded source-row sentinel', () => {
    let examined = 0;
    function* parts() {
      while (examined < BRIEFING_MAX_EXCERPT_SOURCE_ROWS + 5) {
        examined += 1;
        yield textPart('Final text.');
      }
    }
    expect(buildBriefingExcerpt(message, parts())).toBeUndefined();
    expect(examined).toBe(BRIEFING_MAX_EXCERPT_SOURCE_ROWS + 1);
  });

  it('redacts across part boundaries before applying the UTF-8 byte limit', () => {
    const excerpt = buildBriefingExcerpt(message, [
      textPart('Updated person@example.com api_'),
      textPart('key=topsecret ghp_ABC123 '),
      textPart('🙂界'.repeat(400)),
    ]);
    expect(excerpt?.text).toContain('Updated [redacted email]');
    expect(excerpt?.text).not.toMatch(/person@example.com|topsecret|ghp_ABC123/);
    expect(new TextEncoder().encode(excerpt?.text).byteLength).toBeLessThanOrEqual(
      BRIEFING_MAX_EXCERPT_BYTES
    );
    expect(excerpt?.text).not.toContain('\uFFFD');
    expect(excerpt?.text).toBe(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        new TextEncoder().encode(excerpt?.text)
      )
    );
  });
});
