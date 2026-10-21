import { describe, expect, it } from '@jest/globals';
import {
  generateContentUpstreamTarget,
  isServerSentEventsStream,
  parseGenerateContentPath,
} from './generate-content';

describe('parseGenerateContentPath', () => {
  it.each([
    ['/models/gemini-4-argon:generateContent', 'gemini-4-argon', false],
    ['/models/gemini-4-argon:streamGenerateContent', 'gemini-4-argon', true],
    [
      '/opencode-go/gemini-4-argon-contributor:streamGenerateContent',
      'opencode-go/gemini-4-argon-contributor',
      true,
    ],
    [
      '/models/opencode-go/gemini-4-argon-contributor:generateContent',
      'opencode-go/gemini-4-argon-contributor',
      false,
    ],
    [
      '/v1beta/models/opencode-go/gemini-4-argon-contributor:generateContent',
      'opencode-go/gemini-4-argon-contributor',
      false,
    ],
    [
      '/opencode-go%2Fgemini-4-argon-contributor%3AgenerateContent',
      'opencode-go/gemini-4-argon-contributor',
      false,
    ],
    ['/google/gemma-4-26b-a4b-it:free:generateContent', 'google/gemma-4-26b-a4b-it:free', false],
  ])('parses %s', (path, model, stream) => {
    expect(parseGenerateContentPath(path)).toEqual({ model, stream });
  });

  it.each([
    '/chat/completions',
    '/models/gemini-4-argon:countTokens',
    '/models/:generateContent',
    '/models/gemini-4-argon:generateContent/extra',
    '/models/%E0%A4%A:generateContent',
  ])('rejects %s', path => {
    expect(parseGenerateContentPath(path)).toBeNull();
  });
});

describe('isServerSentEventsStream', () => {
  it.each([
    ['alt=sse', true],
    ['alt=json', false],
    ['', false],
  ])('detects server-sent events for ?%s', (search, expected) => {
    expect(isServerSentEventsStream(new URLSearchParams(search))).toBe(expected);
  });
});

describe('generateContentUpstreamTarget', () => {
  const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];

  it('builds the streaming path and strips gateway-only fields from the body', () => {
    expect(
      generateContentUpstreamTarget({
        model: 'gemini-4-argon-contributor',
        stream: true,
        contents,
        generationConfig: { maxOutputTokens: 100 },
        provider: { data_collection: 'deny' },
        models: ['fallback'],
      })
    ).toEqual({
      path: '/models/gemini-4-argon-contributor:streamGenerateContent',
      search: '?alt=sse',
      body: { contents, generationConfig: { maxOutputTokens: 100 } },
    });
  });

  it('builds the non-streaming path without a query', () => {
    expect(
      generateContentUpstreamTarget({ model: 'gemini-4-argon', stream: false, contents })
    ).toEqual({
      path: '/models/gemini-4-argon:generateContent',
      search: '',
      body: { contents },
    });
  });
});
