import { describe, expect, it } from 'vitest';
import { selectPopupTargetTabId } from './tabs';

describe('popup tab selection', () => {
  it('uses the active tab when the popup is opened from the toolbar', () => {
    expect.assertions(1);

    expect(
      selectPopupTargetTabId(
        { id: 10, url: 'http://127.0.0.1:3000/' },
        [{ id: 10, url: 'http://127.0.0.1:3000/' }],
        'chrome-extension://kilo'
      )
    ).toBe(10);
  });

  it('falls back to the most recently accessed non-popup tab when debugging popup.html directly', () => {
    expect.assertions(1);

    expect(
      selectPopupTargetTabId(
        { id: 30, url: 'chrome-extension://kilo/popup.html' },
        [
          { id: 10, lastAccessed: 100, url: 'http://127.0.0.1:3000/' },
          { id: 20, lastAccessed: 200, url: 'http://127.0.0.1:3001/' },
          { id: 30, lastAccessed: 300, url: 'chrome-extension://kilo/popup.html' },
        ],
        'chrome-extension://kilo'
      )
    ).toBe(20);
  });

  it('falls back to a visible http tab when the active extension page URL is hidden', () => {
    expect.assertions(1);

    expect(
      selectPopupTargetTabId(
        { id: 30, lastAccessed: 300 },
        [
          { id: 10, lastAccessed: 100 },
          { id: 20, lastAccessed: 200, url: 'http://127.0.0.1:3001/' },
          { id: 30, lastAccessed: 300 },
        ],
        'chrome-extension://kilo'
      )
    ).toBe(20);
  });
});
