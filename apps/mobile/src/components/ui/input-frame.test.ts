import { describe, expect, it, vi } from 'vitest';

import { INPUT_FRAME_CLASS, InputFrame } from './input-frame';

// The node project never parses RN's Flow-typed sources, so the primitive's
// view becomes a string element (same pattern as segmented-control.test.ts).
vi.mock('react-native', () => ({ View: 'View' }));

type FrameElement = {
  props?: { className?: string; children?: unknown; onLayout?: unknown };
};

function frame(props: Parameters<typeof InputFrame>[0]): FrameElement {
  // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
  return InputFrame(props) as unknown as FrameElement;
}

describe('InputFrame', () => {
  it('draws the contract control chrome around the field', () => {
    const classes = String(frame({ children: 'field' }).props?.className).split(' ');

    expect(classes).toEqual(
      expect.arrayContaining(['rounded-md', 'border', 'border-input', 'bg-background'])
    );
    // The field recipe's dark fill, so a composer has a surface of its own in
    // dark mode instead of only a border against the page.
    expect(classes).toContain('dark:bg-[#FFFFFF0A]');
    expect(classes).toEqual(INPUT_FRAME_CLASS.split(' '));
  });

  it('keeps a caller layout class and the frame handlers', () => {
    const onLayout = vi.fn();
    const element = frame({ children: 'field', className: 'flex-1 overflow-hidden', onLayout });

    expect(String(element.props?.className).split(' ')).toEqual(
      expect.arrayContaining(['flex-1', 'overflow-hidden', 'rounded-md', 'border-input'])
    );
    expect(element.props?.onLayout).toBe(onLayout);
  });

  // A field under an error or a fixed surface overrides one token without
  // re-spelling the rest of the chrome.
  it('lets a caller override one chrome token', () => {
    const classes = String(frame({ children: 'field', className: 'border-destructive' }).props?.className).split(' ');

    expect(classes).toContain('border-destructive');
    expect(classes).not.toContain('border-input');
    expect(classes).toEqual(expect.arrayContaining(['rounded-md', 'bg-background']));
  });

  it('renders the field it wraps', () => {
    expect(frame({ children: 'field' }).props?.children).toBe('field');
  });
});
