import { describe, expect, jest, test } from '@jest/globals';
import type OpenAI from 'openai';
import { sanitizeJsonRefToolResults } from '@kilocode/web-shared/lib/ai-gateway/providers/sanitize-json-ref-tool-results';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function makeChatRequest(messages: OpenAI.Chat.ChatCompletionMessageParam[]): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: { model: 'google/gemini-3.1-pro-preview', messages },
  };
}

function toolContent(request: GatewayRequest): unknown {
  if (request.kind !== 'chat_completions') throw new Error('expected a chat completions request');
  const message = request.body.messages.find(msg => msg.role === 'tool');
  if (!message || message.role !== 'tool') throw new Error('expected a tool message');
  return message.content;
}

function renameRefsIn(content: string): string {
  const request = makeChatRequest([
    { role: 'user', content: 'Run the tool' },
    { role: 'tool', tool_call_id: 'call_1', content },
  ]);
  sanitizeJsonRefToolResults(request);
  const result = toolContent(request);
  if (typeof result !== 'string') throw new Error('expected string tool content');
  return result;
}

function nestedChain(depth: number): unknown {
  let node: unknown = { $ref: '#/$defs/leaf' };
  for (let level = 0; level < depth; level += 1) {
    node = { child: node };
  }
  return node;
}

function deepestChild(value: unknown): Record<string, unknown> {
  let current = value as Record<string, unknown>;
  while (typeof current.child === 'object' && current.child !== null) {
    current = current.child as Record<string, unknown>;
  }
  return current;
}

describe('sanitizeJsonRefToolResults', () => {
  test('renames $ref properties in tool message content and leaves other messages alone', () => {
    const request = makeChatRequest([
      { role: 'user', content: '{"$ref":"#/$defs/request"}' },
      { role: 'tool', tool_call_id: 'call_1', content: '{"$ref":"#/$defs/result"}' },
    ]);

    sanitizeJsonRefToolResults(request);

    if (request.kind !== 'chat_completions') return;
    expect(request.body.messages.at(0)?.content).toBe('{"$ref":"#/$defs/request"}');
    expect(toolContent(request)).toBe('{"_ref":"#/$defs/result"}');
  });

  test('renames $ref properties in the text parts of a tool message', () => {
    const request = makeChatRequest([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [{ type: 'text', text: '{"wrapped":{"$ref":"#/$defs/result"}}' }],
      },
    ]);

    sanitizeJsonRefToolResults(request);

    expect(toolContent(request)).toEqual([
      { type: 'text', text: '{"wrapped":{"_ref":"#/$defs/result"}}' },
    ]);
  });

  test('leaves content that is not JSON unchanged', () => {
    expect(renameRefsIn('$ref is not JSON here')).toBe('$ref is not JSON here');
  });

  test('renames $ref at every depth of a payload within the depth budget', () => {
    const content = JSON.stringify(nestedChain(20));

    const renamed = renameRefsIn(content);

    expect(deepestChild(JSON.parse(renamed))).toEqual({ _ref: '#/$defs/leaf' });
  });

  test('does not parse content that cannot contain $ref', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const plain = '{"a":1,"nested":{"b":[1,2,3]}}';
      const result = renameRefsIn(plain);
      expect(parse).not.toHaveBeenCalled();
      expect(result).toBe(plain);

      // The same spy does catch a parse of content that names the property.
      expect(renameRefsIn('{"$ref":"#/$defs/result"}')).toBe('{"_ref":"#/$defs/result"}');
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  test('leaves a payload whose nesting exceeds the depth budget unchanged', () => {
    const content = JSON.stringify(nestedChain(80));

    const result = renameRefsIn(content);

    expect(result).toBe(content);
    expect(deepestChild(JSON.parse(result))).toEqual({ $ref: '#/$defs/leaf' });
  });

  test('leaves a payload that exceeds the node budget unchanged', () => {
    const content = JSON.stringify({
      $ref: '#/$defs/root',
      items: Array.from({ length: 100_000 }, () => 0),
    });

    const result = renameRefsIn(content);

    expect(result).toBe(content);
    expect(JSON.parse(result)).toMatchObject({ $ref: '#/$defs/root' });
  });

  test('renames a payload just below the node budget', () => {
    const content = JSON.stringify({
      $ref: '#/$defs/root',
      items: Array.from({ length: 1_000 }, () => 0),
    });

    const result = renameRefsIn(content);

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed._ref).toBe('#/$defs/root');
    expect(parsed.$ref).toBeUndefined();
  });
});
