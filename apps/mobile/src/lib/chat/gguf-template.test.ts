import { type ModelRequest } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import {
  answerOf,
  contextWindowFor,
  paramsOf,
  readCompletion,
  stopOf,
  templateSupportsTools,
} from './gguf-template';

describe('the context window', () => {
  it('caps a long trained window and rounds down to the 256-token block', () => {
    expect(
      contextWindowFor({ 'general.architecture': 'qwen2', 'qwen2.context_length': 32_768 })
    ).toBe(4096);
    expect(
      contextWindowFor({ 'general.architecture': 'llama', 'llama.context_length': 1000 })
    ).toBe(768);
  });

  it('uses the cap for a model that states no length, and for metadata it cannot read', () => {
    expect(contextWindowFor({})).toBe(4096);
    expect(contextWindowFor('nonsense')).toBe(4096);
    expect(contextWindowFor(undefined)).toBe(4096);
  });
});

type Templates = Parameters<typeof templateSupportsTools>[0];
type Caps = Templates['jinja']['defaultCaps'];

const CAPS: Caps = { tools: true, toolCalls: true, systemRole: true, parallelToolCalls: false };

describe('the tool rule', () => {
  it('sends tools only for a Jinja template that renders them and earlier calls', () => {
    expect(
      templateSupportsTools({
        llamaChat: false,
        jinja: { default: true, defaultCaps: CAPS, toolUse: false },
      })
    ).toBe(true);
    expect(
      templateSupportsTools({
        llamaChat: false,
        jinja: { default: true, defaultCaps: { ...CAPS, toolCalls: false }, toolUse: false },
      })
    ).toBe(false);
    expect(
      templateSupportsTools({
        llamaChat: true,
        jinja: { default: false, defaultCaps: CAPS, toolUse: false },
      })
    ).toBe(false);
  });

  it('prefers the tool-use template when the model ships one', () => {
    expect(
      templateSupportsTools({
        llamaChat: false,
        jinja: {
          default: false,
          defaultCaps: CAPS,
          toolUse: true,
          toolUseCaps: { ...CAPS, tools: false },
        },
      })
    ).toBe(false);
  });
});

const request: ModelRequest = {
  model: 'file-a',
  maxTokens: 8192,
  tools: [{ name: 'time', description: 'now', parameters: { type: 'object', properties: {} } }],
  prompt: {
    system: [{ text: 'Be brief.', cache: false }],
    messages: [
      { role: 'user', cache: false, parts: [{ kind: 'text', text: 'Hi' }] },
      {
        role: 'assistant',
        cache: false,
        parts: [{ kind: 'toolCall', callId: 'c1', name: 'time', arguments: '{}' }],
      },
      {
        role: 'user',
        cache: false,
        parts: [{ kind: 'toolResult', callId: 'c1', body: 'noon', failed: false }],
      },
    ],
  },
};

describe('the llama.rn call', () => {
  it('renders the history through the model template and caps the answer to the window', () => {
    const params = paramsOf(request, { path: '/m/a.gguf', contextWindow: 2048, tools: false });
    expect(params.n_predict).toBe(2048);
    expect(params.jinja).toBe(true);
    expect(params.enable_thinking).toBe(false);
    expect(params.tools).toBeUndefined();
    expect(params.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('sends the tool list and keeps calls and results for a model that supports tools', () => {
    const params = paramsOf(request, { path: '/m/a.gguf', contextWindow: 4096, tools: true });
    expect(params.tool_choice).toBe('auto');
    expect(params.tools).toHaveLength(1);
    expect(params.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ type: 'function', id: 'c1', function: { name: 'time', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'noon' },
    ]);
  });
});

describe('the native result', () => {
  it('reads the counts, the stop and the answer out of the shape llama.rn really sends', () => {
    const outcome = readCompletion({
      text: 'Hello',
      tokens_evaluated: 12,
      tokens_predicted: 3,
      interrupted: false,
      context_full: false,
      stopped_eos: true,
      stopped_word: false,
      stopped_limit: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('a plain result must be readable');
    }
    expect(outcome.value.tokens_evaluated).toBe(12);
    expect(stopOf(outcome.value)).toBe('end');
    expect(answerOf(outcome.value)).toBe('Hello');
  });

  it('prefers the parsed content and reports tools and a full context', () => {
    const outcome = readCompletion({
      text: '{"name":"time"}',
      content: '',
      accumulated_text: '{"name":"time"}',
      tool_calls: [{ id: 'call-9', function: { name: 'time', arguments: '{}' } }],
      tokens_evaluated: 1,
      tokens_predicted: 1,
      stopped_limit: true,
    });
    expect(outcome.ok && stopOf(outcome.value)).toBe('tools');
    expect(answerOf(outcome.ok ? outcome.value : (undefined as never))).toBe('');
    expect(readCompletion({ text: 'x', tokens_evaluated: 1, tokens_predicted: 1 }).ok).toBe(true);
    expect(readCompletion('not a result').ok).toBe(false);
  });
});
