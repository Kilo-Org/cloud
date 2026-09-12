import { createElement, Fragment, type ReactElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from './renderer';

const mounted: ReactTestRenderer[] = [];

function Empty() {
  return null;
}

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
  vi.unstubAllGlobals();
});

describe('maintained renderer contract', () => {
  it('retains component and host identity while reading current props after multiple commits', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      const onPress = () => {
        setCount(value => value + 1);
      };
      return createElement('Button', { count, onPress }, count);
    }
    const renderer = await render(createElement(Counter));
    const root = renderer.root;
    const button = root.findByType('Button');
    const press = button.props.onPress as () => void;
    act(press);
    act(press);
    expect(button.props.count).toBe(2);
    expect(button.children).toEqual(['2']);
    expect(root.findByType('Button')).toBe(button);
    expect(renderer.root.findByType(Counter)).toBe(root);
    expect(root.parent).toBeNull();
  });

  it('keeps empty components queryable without inventing visible output', async () => {
    const renderer = await render(createElement(Empty));
    expect(renderer.toJSON()).toBeNull();
    expect(renderer.root.findByType(Empty).children).toEqual([]);
    expect(renderer.root.findAll(node => typeof node.type === 'string')).toEqual([]);
    expect(() => renderer.root.findByType('Text')).toThrow('received 0');
  });

  it('preserves keyed siblings, query cardinality, and serialized host output', async () => {
    const row = (key: string) => createElement('Text', { key, testID: key }, key);
    const renderer = await render(createElement(Fragment, null, row('first'), row('second')));
    const first = renderer.root.findByProps({ testID: 'first' });
    expect(renderer.root.findAllByType('Text')).toHaveLength(2);
    expect(() => renderer.root.findByType('Text')).toThrow('received 2');
    await act(async () => {
      renderer.update(createElement(Fragment, null, row('second'), row('first')));
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'first' })).toBe(first);
    expect(renderer.toJSON()).toMatchObject([
      { type: 'Text', props: { testID: 'second' }, children: ['second'] },
      { type: 'Text', props: { testID: 'first' }, children: ['first'] },
    ]);
    expect(renderer.root.findAllByType('TestRoot')).toEqual([]);
  });

  it('runs effect cleanup at unmount', async () => {
    const cleanup = vi.fn<() => void>();
    function Probe() {
      useEffect(() => cleanup, []);
      return null;
    }
    const renderer = await render(createElement(Probe));
    expect(cleanup).not.toHaveBeenCalled();
    renderer.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('act environment', () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

  it.each([undefined, false, true])(
    'restores %s after synchronous and asynchronous work',
    async previous => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', previous);
      act(() => {
        expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(true);
      });
      expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(previous);
      await act(async () => {
        await Promise.resolve();
        expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(true);
      });
      expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(previous);
    }
  );

  it('propagates errors and restores the environment on both rejection paths', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const error = new Error('failed work');
    expect(() =>
      act(() => {
        throw error;
      })
    ).toThrow(error);
    expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(false);
    await expect(
      act(async () => {
        await Promise.resolve();
        throw error;
      })
    ).rejects.toBe(error);
    expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(false);
  });
});
