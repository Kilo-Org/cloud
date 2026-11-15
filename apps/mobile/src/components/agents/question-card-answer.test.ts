import { describe, expect, it } from 'vitest';

import {
  answerLabels,
  isAnswered,
  isCustomSelected,
  MULTI_NONE,
  type MultiAnswer,
  pressSingleChoice,
  pressSingleCustom,
  SINGLE_NONE,
  type SingleAnswer,
  toggleMultiChoice,
  toggleMultiCustom,
  typeMultiCustom,
  typeSingleCustom,
} from './question-card-answer';

const OPTIONS = [{ label: 'Continue' }, { label: 'Stop' }];

describe('single-choice answers', () => {
  it('a preset press drops the custom selection while a re-press of the selected custom radio keeps it', () => {
    let answer: SingleAnswer = SINGLE_NONE;
    answer = typeSingleCustom(answer, true);
    expect(answer).toEqual({ kind: 'custom' });
    expect(isCustomSelected(answer)).toBe(true);
    expect(answerLabels(answer, 'deploy staging', OPTIONS)).toEqual(['deploy staging']);
    expect(isAnswered(answer, 'deploy staging')).toBe(true);

    // Tapping a preset replaces the custom answer, so its text is no longer
    // part of the payload even though the field still holds it.
    answer = pressSingleChoice(answer, 0);
    expect(answer).toEqual({ kind: 'one', choice: 0 });
    expect(answerLabels(answer, 'deploy staging', OPTIONS)).toEqual(['Continue']);
    expect(isAnswered(answer, 'deploy staging')).toBe(true);

    // The radio keeps a custom answer that already holds text.
    const custom: SingleAnswer = typeSingleCustom(SINGLE_NONE, true);
    expect(pressSingleCustom(custom)).toBe(custom);
    expect(answerLabels(pressSingleCustom(custom), 'deploy staging', OPTIONS)).toEqual([
      'deploy staging',
    ]);
  });

  it('typing empty text clears the custom answer and needs text to be answered', () => {
    const answer = typeSingleCustom({ kind: 'custom' }, false);
    expect(answer).toBe(SINGLE_NONE);
    expect(isAnswered(answer, '')).toBe(false);
    expect(isAnswered({ kind: 'custom' }, '   ')).toBe(false);
    expect(isAnswered({ kind: 'custom' }, 'deploy')).toBe(true);
  });

  it('rejects an answer that holds a set of presets by type', () => {
    // @ts-expect-error A single-choice answer holds one choice index, not a set.
    const presetSet: SingleAnswer = { kind: 'presets', chosen: new Set([1, 2]) };
    expect(presetSet).toBeDefined();

    // @ts-expect-error A single-choice answer cannot hold presets beside the custom field.
    const combined: SingleAnswer = { kind: 'presets-and-custom', chosen: new Set([1]) };
    expect(combined).toBeDefined();
  });
});

describe('multi-choice answers', () => {
  it('toggles presets and the custom answer independently', () => {
    let answer: MultiAnswer = MULTI_NONE;
    answer = toggleMultiChoice(answer, 0);
    expect(answer).toEqual({ kind: 'presets', chosen: new Set([0]) });
    expect(answerLabels(answer, 'anything', OPTIONS)).toEqual(['Continue']);

    answer = toggleMultiChoice(answer, 1);
    expect(answer).toEqual({ kind: 'presets', chosen: new Set([0, 1]) });

    answer = toggleMultiCustom(answer);
    expect(answer).toEqual({ kind: 'presets-and-custom', chosen: new Set([0, 1]) });
    expect(answerLabels(answer, 'deploy staging', OPTIONS)).toEqual([
      'Continue',
      'Stop',
      'deploy staging',
    ]);

    answer = toggleMultiCustom(answer);
    expect(answer).toEqual({ kind: 'presets', chosen: new Set([0, 1]) });
    expect(isCustomSelected(answer)).toBe(false);
  });

  it('typing text adds the custom answer and clearing it keeps the presets', () => {
    let answer: MultiAnswer = toggleMultiChoice(MULTI_NONE, 1);
    answer = typeMultiCustom(answer, true);
    expect(answer).toEqual({ kind: 'presets-and-custom', chosen: new Set([1]) });

    answer = typeMultiCustom(answer, false);
    expect(answer).toEqual({ kind: 'presets', chosen: new Set([1]) });

    expect(isAnswered(MULTI_NONE, 'text')).toBe(false);
    expect(isAnswered({ kind: 'custom' }, 'text')).toBe(true);
  });

  it('drops to none when the last preset and the custom answer are both removed', () => {
    let answer: MultiAnswer = toggleMultiCustom(MULTI_NONE);
    expect(answer).toEqual({ kind: 'custom' });

    answer = toggleMultiChoice(answer, 0);
    expect(answer).toEqual({ kind: 'presets-and-custom', chosen: new Set([0]) });

    answer = toggleMultiChoice(answer, 0);
    expect(answer).toEqual({ kind: 'custom' });

    expect(toggleMultiCustom(answer)).toBe(MULTI_NONE);
  });
});
