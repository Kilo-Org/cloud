import { describe, expect, it } from 'vitest';
import type { LatestAssistantMessage, AssistantMessagePart } from '../session/types.js';
import { renderRecentActivity } from './recent-activity.js';

function message(id: number, parts: Partial<AssistantMessagePart>[]): LatestAssistantMessage {
  return {
    eventId: id as LatestAssistantMessage['eventId'],
    timestamp: id,
    info: { id: String(id), role: 'assistant', secretMetadata: 'private' },
    parts: parts.map((part, index) => ({ id: String(index), messageID: String(id), ...part })),
  };
}

describe('renderRecentActivity', () => {
  it('keeps earlier narration and tool statuses when the latest assistant message is empty', () => {
    expect(
      JSON.parse(
        renderRecentActivity([
          message(1, [{ type: 'text', text: 'Investigating the failing test' }]),
          message(2, [
            {
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: 'secret', output: 'secret', error: 'secret' },
            },
          ]),
          message(3, []),
        ]) ?? 'null'
      )
    ).toEqual({
      partial: true,
      messages: [
        { text: 'Investigating the failing test', tools: [] },
        { tools: [{ name: 'bash', status: 'completed' }] },
      ],
    });
  });

  it('excludes reasoning, tool contents, errors, and arbitrary metadata', () => {
    const rendered = renderRecentActivity([
      message(1, [
        { type: 'reasoning', text: 'private reasoning' },
        {
          type: 'tool',
          tool: 'read',
          state: {
            status: 'error',
            input: 'private input',
            output: 'private output',
            error: 'private error',
            metadata: 'private metadata',
          },
        },
        { type: 'tool', tool: 'bad-status', state: { status: 'private status' } },
      ]),
    ]);
    expect(rendered).toBe(
      JSON.stringify({ partial: true, messages: [{ tools: [{ name: 'read', status: 'error' }] }] })
    );
    expect(rendered).not.toContain('private');
  });

  it('omits activity without eligible text or tools', () => {
    expect(renderRecentActivity([])).toBeUndefined();
    expect(
      renderRecentActivity([
        message(1, [
          { type: 'text', text: '  ' },
          { type: 'reasoning', text: 'reasoning' },
        ]),
      ])
    ).toBeUndefined();
  });

  it('includes a bounded final answer excerpt', () => {
    const rendered = renderRecentActivity([
      message(1, [{ type: 'text', text: 'a'.repeat(20_000) }]),
    ]);
    expect(rendered).toContain('a'.repeat(1_500));
    expect(rendered?.length).toBeLessThan(2_300);
  });

  it('keeps the most recent tool statuses within a message in chronological order', () => {
    const rendered = renderRecentActivity([
      message(
        1,
        Array.from({ length: 8 }, (_, index) => ({
          type: 'tool',
          tool: `tool-${index}`,
          state: { status: 'completed' },
        }))
      ),
    ]);
    expect(JSON.parse(rendered ?? 'null').messages[0].tools).toEqual(
      [3, 4, 5, 6, 7].map(index => ({ name: `tool-${index}`, status: 'completed' }))
    );
  });

  it('bounds the chronological tail, escaped JSON, Unicode excerpts and serialized bytes', () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message(index, [
        { type: 'text', text: `${index}:` + '\u{1f600}"\\\n\u0000'.repeat(5_000) },
        ...Array.from({ length: 20 }, () => ({
          type: 'tool',
          tool: '\u0000'.repeat(200),
          state: { status: 'running' },
        })),
      ])
    );
    const rendered = renderRecentActivity(messages);
    expect(rendered).toBeDefined();
    if (!rendered) return;
    const parsed = JSON.parse(rendered);
    expect(parsed.partial).toBe(true);
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages.map((entry: { text: string }) => entry.text.slice(0, 2))).toEqual([
      '3:',
      '4:',
      '5:',
      '6:',
      '7:',
    ]);
    expect(rendered.length).toBeLessThanOrEqual(12_000);
    expect(
      new TextEncoder().encode(JSON.stringify({ recentActivity: rendered })).byteLength
    ).toBeLessThan(70_000);
    expect(rendered).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(parsed.messages.every((entry: { tools: unknown[] }) => entry.tools.length <= 5)).toBe(
      true
    );
  });
});
