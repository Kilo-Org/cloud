// The keyword and topic fields keep the whole paste. Their per-entry and
// entry-count limits are validated on the parsed lines (`guardrailsIssues`), so
// the textarea carries no whole-text cap: a cap built from the product of the
// two limits is shorter than a maximal valid list once its newlines count, and
// it silently cut the last entry mid-token.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { LineListField } from './guardrails-detector-editor';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/filter-chip', () => ({ FilterChip: 'FilterChip' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: ReactTestRenderer | undefined = undefined;

function mount(value: string): ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(
      createElement(LineListField, {
        label: 'Blocked keywords',
        hint: 'One per line',
        value,
        onChange: () => undefined,
        disabled: false,
      })
    );
  });
  if (!renderer) {
    throw new Error('Missing field renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('LineListField', () => {
  it('renders a maximal list whole, without a whole-text cap', () => {
    const value = Array.from({ length: 200 }, () => 'x'.repeat(100)).join('\n');
    const field = mount(value).findByType('FormField' as never);

    expect(field.props.maxLength).toBeUndefined();
    expect(field.props.defaultValue).toBe(value);
  });
});
