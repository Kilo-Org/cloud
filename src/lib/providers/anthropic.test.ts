import type OpenAI from 'openai';
import { addCacheBreakpoints } from './anthropic';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

function msg(role: 'system' | 'user' | 'assistant' | 'tool', content: string): Message {
  if (role === 'tool') {
    return { role: 'tool', content, tool_call_id: 'call_1' };
  }
  return { role, content } as Message;
}

function msgWithParts(
  role: 'system' | 'user' | 'assistant',
  parts: OpenAI.Chat.ChatCompletionContentPart[]
): Message {
  return { role, content: parts } as Message;
}

function hasCacheBreakpoint(message: Message): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(part => 'cache_control' in part);
}

describe('addCacheBreakpoints', () => {
  it('does nothing when there is no system prompt', () => {
    const messages: Message[] = [msg('user', 'hello')];
    addCacheBreakpoints(messages);
    // user message should remain a plain string (no cache_control added)
    expect(messages[0].content).toBe('hello');
  });

  it('does nothing when the system prompt already has cache_control', () => {
    const messages: Message[] = [
      msgWithParts('system', [
        { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } } as never,
      ]),
      msg('user', 'hello'),
    ];
    addCacheBreakpoints(messages);
    // user message should be untouched
    expect(messages[1].content).toBe('hello');
  });

  it('sets cache breakpoint on system prompt (string content)', () => {
    const messages: Message[] = [msg('system', 'You are helpful'), msg('user', 'hello')];
    addCacheBreakpoints(messages);

    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(hasCacheBreakpoint(messages[0])).toBe(true);
  });

  it('sets cache breakpoint on system prompt (array content)', () => {
    const messages: Message[] = [
      msgWithParts('system', [{ type: 'text', text: 'You are helpful' }]),
      msg('user', 'hello'),
    ];
    addCacheBreakpoints(messages);

    expect(hasCacheBreakpoint(messages[0])).toBe(true);
  });

  it('sets cache breakpoint on the last user message', () => {
    const messages: Message[] = [
      msg('system', 'system prompt'),
      msg('user', 'first'),
      msg('assistant', 'reply'),
      msg('user', 'second'),
    ];
    addCacheBreakpoints(messages);

    // last user message ("second") should have cache_control
    expect(hasCacheBreakpoint(messages[3])).toBe(true);
  });

  it('sets cache breakpoint on the last tool message when no trailing user message', () => {
    const messages: Message[] = [
      msg('system', 'system prompt'),
      msg('user', 'run the tool'),
      msg('assistant', 'calling tool'),
      msg('tool', 'tool result'),
    ];
    addCacheBreakpoints(messages);

    expect(hasCacheBreakpoint(messages[3])).toBe(true);
  });

  it('sets cache breakpoint on the user/tool message before the last assistant message', () => {
    const messages: Message[] = [
      msg('system', 'system prompt'),
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
    ];
    addCacheBreakpoints(messages);

    // "first question" is the user message before the last assistant message
    expect(hasCacheBreakpoint(messages[1])).toBe(true);
    // system and last user should also be marked
    expect(hasCacheBreakpoint(messages[0])).toBe(true);
    expect(hasCacheBreakpoint(messages[3])).toBe(true);
  });

  it('handles a minimal conversation with only system and user', () => {
    const messages: Message[] = [msg('system', 'system prompt'), msg('user', 'hi')];
    addCacheBreakpoints(messages);

    expect(hasCacheBreakpoint(messages[0])).toBe(true);
    expect(hasCacheBreakpoint(messages[1])).toBe(true);
  });

  it('does not set a second-to-last breakpoint when there is no assistant message', () => {
    const messages: Message[] = [
      msg('system', 'system prompt'),
      msg('user', 'first'),
      msg('user', 'second'),
    ];
    addCacheBreakpoints(messages);

    // system and last user should be marked, but first user should not
    expect(hasCacheBreakpoint(messages[0])).toBe(true);
    expect(messages[1].content).toBe('first'); // still a plain string
    expect(hasCacheBreakpoint(messages[2])).toBe(true);
  });

  it('does not duplicate breakpoints when the same message is both last-user and second-to-last', () => {
    const messages: Message[] = [
      msg('system', 'system prompt'),
      msg('user', 'only user message'),
      msg('assistant', 'reply'),
    ];
    addCacheBreakpoints(messages);

    // "only user message" is both lastUser and previousUser — should still work
    expect(hasCacheBreakpoint(messages[0])).toBe(true);
    expect(hasCacheBreakpoint(messages[1])).toBe(true);
  });
});
