/* eslint-disable typescript-eslint/consistent-type-assertions -- a llama.rn context is a JSI object: a test double can only be built by asserting its shape */
import { type ModelError } from '@kilocode/harness-sdk';
import { expect, vi } from 'vitest';

import { type GgufContext } from './gguf-client';
import { LocalModelError, type LocalModelProblem } from './local-model-error';

/**
 * A context whose answer only ends when the native stop reaches it: llama.cpp
 * then reports the stop as `interrupted`, which is what a release produces.
 */
export function interruptedContext(timeline: string[], name: string) {
  const started = Promise.withResolvers<undefined>();
  const stopped = Promise.withResolvers<unknown>();
  return {
    started: started.promise,
    context: {
      model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
      completion: (_params: unknown, onToken?: (data: unknown) => void) => {
        onToken?.({ token: 'Part', content: 'Part', accumulated_text: 'Part' });
        started.resolve(undefined);
        return stopped.promise;
      },
      // The stop is what ends the answer, so the release below reaches it.
      stopCompletion: vi.fn(() => {
        timeline.push(`stopped ${name}`);
        stopped.resolve({
          text: 'Part',
          content: 'Part',
          accumulated_text: 'Part',
          tokens_evaluated: 5,
          tokens_predicted: 1,
          interrupted: true,
          stopped_eos: false,
        });
        return Promise.resolve();
      }),
      release: vi.fn(() => {
        timeline.push(`freed ${name}`);
        return Promise.resolve();
      }),
    } as unknown as GgufContext,
  };
}

/** The problem class a refused answer carries, read through the error it holds. */
export function problemOf(failure: unknown): LocalModelProblem {
  const cause: unknown = (failure as ModelError).cause;
  expect(cause).toBeInstanceOf(LocalModelError);
  return (cause as LocalModelError).problem;
}
