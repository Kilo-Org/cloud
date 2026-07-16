import { describe, expect, it } from 'vitest';

import {
  getLinkAccessibilityActions,
  getLinkLongPressHandler,
  LINK_ACCESSIBILITY_HINT,
  resolveLinkAccessibilityLabel,
} from './markdown-link';

const onLongPressLink = () => undefined;

describe('resolveLinkAccessibilityLabel', () => {
  it('prefers an explicit title', () => {
    expect(resolveLinkAccessibilityLabel('click here', 'https://example.com', 'Example site')).toBe(
      'Example site'
    );
  });

  it('falls back to the visible link text when there is no title', () => {
    expect(resolveLinkAccessibilityLabel('Kilo Code docs', 'https://kilo.ai/docs')).toBe(
      'Kilo Code docs'
    );
  });

  it('falls back to the URL host when the link text is not a plain string', () => {
    expect(resolveLinkAccessibilityLabel([], 'https://kilo.ai/docs/getting-started')).toBe(
      'kilo.ai'
    );
  });

  it('falls back to the raw href when no host can be parsed', () => {
    expect(resolveLinkAccessibilityLabel([], 'mailto:hello@kilo.ai')).toBe('mailto:hello@kilo.ai');
  });
});

describe('link action accessibility', () => {
  it('describes the existing in-app browser behavior', () => {
    expect(LINK_ACCESSIBILITY_HINT).toBe('Opens in browser');
  });

  it('exposes link actions only when the chat callback is enabled', () => {
    expect(getLinkAccessibilityActions(false)).toBeUndefined();
    expect(getLinkAccessibilityActions(true)).toEqual([
      { name: 'showLinkActions', label: 'Show link actions' },
    ]);
  });

  it('attaches a long-press handler only when chat link actions are enabled', () => {
    expect(getLinkLongPressHandler(undefined, 'https://kilo.ai')).toBeUndefined();
    expect(getLinkLongPressHandler(onLongPressLink, 'https://kilo.ai')).toBeTypeOf('function');
  });
});
