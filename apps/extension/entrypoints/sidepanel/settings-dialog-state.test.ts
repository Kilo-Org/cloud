import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { settingsDialogOpenAtom } from './settings-dialog-state';

describe('settings dialog open atom', () => {
  it('defaults to false', () => {
    const store = createStore();
    expect(store.get(settingsDialogOpenAtom)).toBe(false);
  });
});
