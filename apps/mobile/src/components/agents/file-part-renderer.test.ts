/* oxlint-disable @typescript-eslint/no-unsafe-member-access -- React element props are untyped; the mounted suites use the same access pattern */
/* eslint-disable new-cap -- calling FilePartRenderer as a plain function to assert on the element it produces */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type FilePart } from '@kilocode/cloud-agent-sdk';

import { FilePartRenderer } from './file-part-renderer';

// The renderer is a pure function of its part: invoke it directly (no
// renderer) and walk the element tree it returns. Every RN/UI module is
// mocked to string components so the node env never loads native bindings.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('lucide-react-native', () => ({ File: 'FileIcon' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6b7280' }),
}));

type ImageElement = ReactElement<{
  accessible?: boolean;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  children?: ReactNode;
}>;

function childNodes(element: ImageElement): ReactNode[] {
  const children = element.props.children;
  if (children == null) {
    return [];
  }
  return Array.isArray(children) ? children : [children];
}

function imageElements(element: ImageElement): ImageElement[] {
  const found: ImageElement[] = [];
  if (element.type === 'Image') {
    found.push(element);
  }
  for (const child of childNodes(element)) {
    if (isValidElement(child)) {
      found.push(...imageElements(child as ImageElement));
    }
  }
  return found;
}

function imagePart(overrides: Partial<FilePart> = {}): FilePart {
  return {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'file',
    mime: 'image/png',
    filename: 'photo.png',
    url: 'https://x/photo.png',
    ...overrides,
  };
}

describe('FilePartRenderer — image label forwarding (Row 3.3)', () => {
  it('labels the image with its filename and exposes it to assistive technology', () => {
    const element = FilePartRenderer({ part: imagePart() }) as ImageElement;
    const images = imageElements(element);
    expect(images).toHaveLength(1);
    expect(images[0]?.props.accessibilityLabel).toBe('Image output, photo.png');
    // expo-image defaults `accessible` to false, so the label alone would
    // leave the image unreachable.
    expect(images[0]?.props.accessible).toBe(true);
    expect(images[0]?.props.accessibilityRole).toBe('image');
  });

  it('falls back to a generic label when the image part has no filename', () => {
    const element = FilePartRenderer({
      part: imagePart({ filename: undefined }),
    }) as ImageElement;
    const images = imageElements(element);
    expect(images).toHaveLength(1);
    expect(images[0]?.props.accessibilityLabel).toBe('Image output');
  });

  it('renders a file row with no Image element for a non-image part', () => {
    const element = FilePartRenderer({
      part: imagePart({ mime: 'application/pdf', filename: 'doc.pdf' }),
    }) as ImageElement;
    expect(imageElements(element)).toHaveLength(0);
  });
});
