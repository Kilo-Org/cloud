/* oxlint-disable @typescript-eslint/no-unsafe-member-access -- React element props are untyped; the mounted suites use the same access pattern */
/* eslint-disable new-cap -- calling Image as a plain function to assert on the element it produces */
import { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Image } from './image';

// The component is a pure function of its props: invoke it directly (no
// renderer) and assert on the element it returns. `expo-image` and
// `nativewind` are mocked so the node env never loads native bindings.
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));
vi.mock('nativewind', () => ({
  styled: (component: unknown) => component,
}));

type RenderedImage = ReactElement<{
  accessible?: boolean;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  contentFit?: string;
  source?: { uri?: string };
}>;

function renderImage(props: Record<string, unknown>): RenderedImage {
  return Image(props as unknown as Parameters<typeof Image>[0]) as RenderedImage;
}

describe('Image — decorative default and alt semantics (Row 3.3)', () => {
  it('stays decorative when alt is omitted: no accessible props are attached', () => {
    const element = renderImage({ source: { uri: 'https://x/a.png' }, contentFit: 'cover' });
    expect(element.props.accessible).toBeUndefined();
    expect(element.props.accessibilityRole).toBeUndefined();
    expect(element.props.accessibilityLabel).toBeUndefined();
    // The visual source and fit passthrough are preserved for the thumbnail.
    expect(element.props.contentFit).toBe('cover');
    expect(element.props.source).toEqual({ uri: 'https://x/a.png' });
  });

  it('exposes a labeled image role when alt is set', () => {
    const element = renderImage({
      source: { uri: 'https://x/a.png' },
      alt: 'Photo of a cat',
      contentFit: 'cover',
    });
    expect(element.props.accessible).toBe(true);
    expect(element.props.accessibilityRole).toBe('image');
    expect(element.props.accessibilityLabel).toBe('Photo of a cat');
    expect(element.props.contentFit).toBe('cover');
  });
});
