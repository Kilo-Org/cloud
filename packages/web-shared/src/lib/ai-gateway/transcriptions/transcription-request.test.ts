import { describe, it, expect } from '@jest/globals';
import {
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

describe('extractTranscriptionPromptInfo', () => {
  it('returns a zero system_prompt_length', () => {
    expect(extractTranscriptionPromptInfo()).toEqual({ system_prompt_length: 0 });
  });
});
