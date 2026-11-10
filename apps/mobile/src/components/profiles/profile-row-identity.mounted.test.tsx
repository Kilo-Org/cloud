// The block a profile row announces as its identity. The row's reading order is
// the reason this shape exists, so the mounted case asserts the element shape
// (one element, declared first, spanning the control height) and the pure case
// asserts the label a row composes from the copy it renders.
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { ProfileRowIdentity, profileRowLabel } from './profile-row-identity';

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));

function mountRow(): ReactTestRenderer {
  const holder: { current?: ReactTestRenderer } = {};
  act(() => {
    holder.current = TestRenderer.create(
      createElement(
        'View',
        null,
        createElement(
          ProfileRowIdentity,
          { label: 'code-review, Custom' },
          createElement('Text', { key: 'name' }, 'code-review'),
          createElement('Text', { key: 'source' }, 'Custom')
        ),
        createElement('View', { testID: 'row-control' })
      )
    );
  });
  if (!holder.current) {
    throw new Error('the row did not mount');
  }
  return holder.current;
}

describe('ProfileRowIdentity', () => {
  it('is one accessible element declared before the row controls', () => {
    const row = mountRow();
    const identity = row.root.findAllByType('View')[1];

    expect(identity?.props).toMatchObject({
      accessible: true,
      accessibilityRole: 'text',
      accessibilityLabel: 'code-review, Custom',
    });
    // Tall enough that the controls beside it start on the same top edge, and
    // declared first: assistive technology focuses a row by its layout.
    expect(identity?.props.className).toContain('min-h-[48px]');
    const rowView = identity?.parent as ReactTestInstance;
    expect(rowView.children[0]).toBe(identity);
    expect(row.root.findByProps({ testID: 'row-control' })).toBeTruthy();
  });

  it('hides the copy it renders from assistive technology', () => {
    const row = mountRow();
    const hidden = row.root.findAllByType('View')[2];

    expect(hidden?.props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(hidden?.findAllByType('Text').map(node => node.props.children)).toEqual([
      'code-review',
      'Custom',
    ]);
  });
});

describe('profileRowLabel', () => {
  it('joins the parts that name the item in reading order', () => {
    expect(profileRowLabel('code-review', 'Custom', null, '')).toBe('code-review, Custom');
    expect(profileRowLabel('docs', 'Local', 'npx docs-mcp', '1 secret')).toBe(
      'docs, Local, npx docs-mcp, 1 secret'
    );
  });
});
