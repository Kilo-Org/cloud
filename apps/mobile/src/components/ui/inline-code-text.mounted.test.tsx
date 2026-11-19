/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ComponentProps, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';
import { act, TestRenderer } from '@/test/renderer';

import { InlineCodeText } from './inline-code-text';

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(props: ComponentProps<typeof InlineCodeText>): TestRenderer.ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(createElement(InlineCodeText, props));
  });
  if (!renderer) {
    throw new Error('Missing InlineCodeText renderer');
  }
  return renderer.root;
}

function monoLines(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => String(node.type) === 'Text' && node.props.variant === 'mono');
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('InlineCodeText', () => {
  it('draws a marked command in the mono style and leaves the sentence around it as prose', () => {
    const root = render({
      value: 'Run `kilo remote` in a project on your computer.',
      codeClassName: 'text-muted-foreground',
    });

    const mono = monoLines(root);
    expect(mono).toHaveLength(1);
    // The run keeps the isolated, unbreakable treatment the plain renderer
    // gives a command, so a right-to-left sentence cannot split or reorder it.
    expect(mono[0]?.props.children).toBe(`${LTR_ISOLATE_OPEN}kilo\u00A0remote${LTR_ISOLATE_CLOSE}`);
    expect(mono[0]?.props.className).toBe('text-muted-foreground');

    const [body] = root.findAll(node => String(node.type) === 'Text');
    expect(body?.props.children).toEqual([
      'Run ',
      expect.anything(),
      ' in a project on your computer.',
    ]);
  });

  it('renders copy without a marker as one paragraph', () => {
    const root = render({ value: 'Run Kilo on your own machine.' });

    expect(monoLines(root)).toHaveLength(0);
    const [body] = root.findAll(node => String(node.type) === 'Text');
    expect(body?.props.children).toEqual(['Run Kilo on your own machine.']);
  });

  it('drops a lone authoring marker instead of painting it', () => {
    const root = render({ value: 'Run kilo remote`.' });

    expect(monoLines(root)).toHaveLength(0);
    const [body] = root.findAll(node => String(node.type) === 'Text');
    expect(body?.props.children).toEqual(['Run kilo remote.']);
  });
});
