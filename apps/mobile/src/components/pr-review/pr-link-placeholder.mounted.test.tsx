/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module, typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests that also read the component source off disk. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { PrLinkPlaceholder } from './pr-link-placeholder';

// Mutable so one suite renders under both platforms: the component must draw
// the same overlay whichever OS reports.
const { platform } = vi.hoisted(() => ({ platform: { OS: 'android' } }));

vi.mock('react-native', () => ({
  Platform: platform,
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const PLACEHOLDER = 'Pull request or merge request URL';

// The overlay is the one implementation for both platforms. The two renders
// below flip `platform.OS` at render time, but a `Platform` read captured at
// module scope is taken before either run, so both would look the same; the
// source check catches that half.
const PLACEHOLDER_SOURCE = readFileSync(join(__dirname, 'pr-link-placeholder.tsx'), 'utf8');

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(label: string) {
  act(() => {
    const element = createElement(PrLinkPlaceholder, { label });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing PrLinkPlaceholder renderer');
  }
  return renderer.root;
}

beforeEach(() => {
  platform.OS = 'android';
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('PrLinkPlaceholder mounted layout', () => {
  // A TextInput's native placeholder is not reliably one line: Android lays
  // the hint out on a second line the one-line field clips (pr-review-home at
  // font scale 2), and iOS must render the same field. The overlay must stay
  // on one ellipsized line on both platforms.
  it.each(['android', 'ios'] as const)(
    'draws the placeholder as one tail-ellipsized line on %s',
    os => {
      platform.OS = os;
      const root = render(PLACEHOLDER);
      const row = root.find(
        node => Object.is(node.type, 'View') && node.props.testID === 'pr-link-placeholder'
      );
      expect(row.props.pointerEvents).toBe('none');
      const text = root.find(node => Object.is(node.type, 'Text'));
      expect(text.props.numberOfLines).toBe(1);
      expect(text.props.ellipsizeMode).toBe('tail');
      expect(text.children).toContain(PLACEHOLDER);
    }
  );

  it('keeps no Platform.OS fork in the placeholder component', () => {
    // One implementation for both platforms: with no `Platform` symbol, neither
    // a render-time nor a module-scope read can fork the field.
    expect(PLACEHOLDER_SOURCE).not.toMatch(/\bPlatform\b/);
  });
});
