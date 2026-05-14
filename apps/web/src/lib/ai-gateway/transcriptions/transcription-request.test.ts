import { describe, it, expect } from '@jest/globals';
import {
  buildUpstreamBody,
  extractTranscriptionPromptInfo,
  TranscriptionRequestSchema,
} from './transcription-request';

describe('TranscriptionRequestSchema', () => {
  it('accepts an OpenRouter transcription request', () => {
    const result = TranscriptionRequestSchema.parse({
      model: 'openai/gpt-4o-mini-transcribe',
      input_audio: { data: 'UklGRiQA', format: 'wav' },
      language: 'en',
      temperature: 0,
    });

    expect(result).toEqual({
      model: 'openai/gpt-4o-mini-transcribe',
      input_audio: { data: 'UklGRiQA', format: 'wav' },
      language: 'en',
      temperature: 0,
    });
  });

  it('rejects missing audio data', () => {
    expect(() =>
      TranscriptionRequestSchema.parse({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { format: 'wav' },
      })
    ).toThrow();
  });
});

describe('buildUpstreamBody', () => {
  it('passes through standard and provider fields', () => {
    const body = TranscriptionRequestSchema.parse({
      model: 'openai/gpt-4o-mini-transcribe',
      input_audio: { data: 'UklGRiQA', format: 'wav' },
      language: 'en',
      provider: { only: ['OpenAI'] },
      safety_identifier: 'hash-abc',
      user: 'hash-abc',
    });

    expect(buildUpstreamBody(body)).toEqual(body);
  });
});

describe('extractTranscriptionPromptInfo', () => {
  it('describes audio format without including encoded audio', () => {
    const body = TranscriptionRequestSchema.parse({
      model: 'openai/gpt-4o-mini-transcribe',
      input_audio: { data: 'a'.repeat(200), format: 'wav' },
      language: 'en',
    });

    expect(extractTranscriptionPromptInfo(body)).toEqual({
      system_prompt_prefix: '',
      system_prompt_length: 0,
      user_prompt_prefix: 'audio/wav language=en',
    });
  });
});
