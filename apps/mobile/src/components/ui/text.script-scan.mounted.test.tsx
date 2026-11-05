/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native style regression tests. */
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import type * as RtlText from '@/lib/rtl-text';
import { Text } from './text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

// The real classifiers, counted: the shared text primitive re-renders with its
// parent, so a render with unchanged copy must not scan that copy again.
const scans = vi.hoisted(() => ({ rtlScript: 0, joinedScript: 0 }));
vi.mock('@/lib/rtl-text', async importOriginal => {
  const actual = await importOriginal<typeof RtlText>();
  return {
    ...actual,
    hasRtlScript: (node: ReactNode) => {
      scans.rtlScript += 1;
      return actual.hasRtlScript(node);
    },
    containsJoinedScript: (node: ReactNode) => {
      scans.joinedScript += 1;
      return actual.containsJoinedScript(node);
    },
  };
});

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function textElement(copy: string, props: Record<string, unknown> = {}) {
  return createElement(Text, { className: 'tracking-wide', ...props }, copy);
}

/** The host `Text` the primitive renders. */
function hostText(): TestRenderer.ReactTestInstance {
  if (!renderer) {
    throw new Error('Missing Text renderer');
  }
  return renderer.root.find(node => Object.is(node.type, 'Text'));
}

function create(copy: string, props: Record<string, unknown> = {}): void {
  act(() => {
    renderer = TestRenderer.create(textElement(copy, props));
  });
}

function rerender(copy: string, props: Record<string, unknown> = {}): void {
  const current = renderer;
  if (!current) {
    throw new Error('Missing Text renderer');
  }
  act(() => {
    current.update(textElement(copy, props));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
  scans.rtlScript = 0;
  scans.joinedScript = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('Text — script classification reuse', () => {
  it('does not rescan unchanged copy across re-renders', () => {
    create('مرحبا');
    expect(scans.rtlScript).toBe(1);
    expect(scans.joinedScript).toBe(1);

    rerender('مرحبا');
    rerender('مرحبا');
    expect(scans.rtlScript).toBe(1);
    expect(scans.joinedScript).toBe(1);

    // New copy is a new classification: the cache follows the child tree.
    rerender('hello');
    expect(scans.rtlScript).toBe(2);
    expect(scans.joinedScript).toBe(2);

    rerender('hello');
    expect(scans.rtlScript).toBe(2);
  });

  it('produces the same classes and letter-spacing reset as an uncached render', () => {
    create('مرحبا', { variant: 'mono' });
    const firstClasses = String(hostText().props.className);
    const firstStyle = hostText().props.style;
    expect(firstClasses).not.toContain('font-mono');

    rerender('مرحبا', { variant: 'mono' });
    expect(String(hostText().props.className)).toBe(firstClasses);
    expect(JSON.stringify(hostText().props.style)).toBe(JSON.stringify(firstStyle));
    expect(JSON.stringify(firstStyle)).toContain('"letterSpacing":0');
  });

  it('reclassifies when only the copy changes script', () => {
    create('hello', { variant: 'mono' });
    expect(String(hostText().props.className)).toContain('font-mono');

    rerender('مرحبا', { variant: 'mono' });
    expect(String(hostText().props.className)).not.toContain('font-mono');
    expect(JSON.stringify(hostText().props.style)).toContain('"letterSpacing":0');
  });
});
