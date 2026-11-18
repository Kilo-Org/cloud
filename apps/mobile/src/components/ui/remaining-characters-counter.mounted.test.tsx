import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { RemainingCharactersCounter } from './remaining-characters-counter';

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
// The primitive loads `@rn-primitives/slot`, whose node_modules `.mjs` contains
// JSX this pipeline cannot transform; the row's own contract is the host text.
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

function renderCounter(props: {
  remaining: number;
  className?: string;
}): TestRenderer.ReactTestRenderer {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.current = TestRenderer.create(createElement(RemainingCharactersCounter, props));
  });
  const created = holder.current;
  if (created === undefined) {
    throw new Error('renderer was not created');
  }
  renderer = created;
  return created;
}

function host(rendered: TestRenderer.ReactTestRenderer, type: string) {
  return rendered.root.findAll(node => Object.is(node.type, type));
}

describe('RemainingCharactersCounter mounted', () => {
  it.each([
    [1, '1 character remaining'],
    [35, '35 characters remaining'],
  ])('shows the counted phrase for %i', (remaining, phrase) => {
    const text = host(renderCounter({ remaining }), 'Text')[0];

    expect(text?.props.children).toBe(phrase);
    expect(text?.props.accessibilityLabel).toBeUndefined();
    expect(text?.props.numberOfLines).toBeUndefined();
  });

  it('keeps the right-aligned row and the caller padding', () => {
    const row = host(renderCounter({ remaining: 1, className: 'px-4 pb-1' }), 'View')[0];

    expect(row?.props.className).toBe('flex-row justify-end px-4 pb-1');
  });

  it('defaults to the right-aligned row alone', () => {
    const row = host(renderCounter({ remaining: 2 }), 'View')[0];

    expect(row?.props.className).toBe('flex-row justify-end');
  });
});
