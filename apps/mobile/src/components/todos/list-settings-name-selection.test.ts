// Name-field preview contract (drain work item: a one-line field must show
// the start of a long saved name): the unfocused state renders the one-line
// start-visible preview whenever a saved name exists, editing swaps in the
// real input, and an empty name keeps the input so its placeholder shows.

import { describe, expect, it } from 'vitest';

import { showNamePreview } from './list-settings-name-selection';

describe('showNamePreview', () => {
  it('previews while not editing when a saved name exists', () => {
    expect(showNamePreview({ editing: false, hasText: true })).toBe(true);
  });

  it('swaps to the real input while editing', () => {
    expect(showNamePreview({ editing: true, hasText: true })).toBe(false);
  });

  it('keeps the input for an empty name so the placeholder shows', () => {
    expect(showNamePreview({ editing: false, hasText: false })).toBe(false);
  });
});
