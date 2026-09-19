/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { PrLinkPlaceholder } from './pr-link-placeholder';

// Mutable so one suite covers both platforms: the component is Android-only.
const { platform } = vi.hoisted(() => ({ platform: { OS: 'android' } }));

vi.mock('react-native', () => ({
  Platform: platform,
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const PLACEHOLDER = 'Pull request or merge request URL';

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
  // Android renders a TextInput placeholder as the EditText hint, and RN never
  // marks a single-line input as single-line, so a hint wider than the field
  // wrapped onto a second line the one-line field clipped (pr-review-home at
  // font scale 2). The overlay must stay on one ellipsized line.
  it('draws the placeholder as one tail-ellipsized line over the field', () => {
    const root = render(PLACEHOLDER);
    const row = root.find(
      node => Object.is(node.type, 'View') && node.props.testID === 'pr-link-placeholder'
    );
    expect(row.props.pointerEvents).toBe('none');
    const text = root.find(node => Object.is(node.type, 'Text'));
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
    expect(text.children).toContain(PLACEHOLDER);
  });

  it('renders nothing off Android, where the platform truncates its own placeholder', () => {
    platform.OS = 'ios';
    const root = render(PLACEHOLDER);
    expect(root.findAll(node => Object.is(node.type, 'View'))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, 'Text'))).toHaveLength(0);
  });
});
