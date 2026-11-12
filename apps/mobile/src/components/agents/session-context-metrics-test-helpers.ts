import * as React from 'react';
import { expect } from 'vitest';

import { type SessionContextInfo } from '@/lib/session-context-info';

import { SessionContextMetrics } from './session-context-metrics';

/**
 * Walks the element tree these tests render by calling the component as a plain
 * function, and returns every element the predicate accepts.
 */
export function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];

  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      const element = value as React.ReactElement<{ children?: unknown }>;
      if (predicate(element)) {
        matches.push(element);
      }
      // These suites call components as plain functions, so a child component
      // element is still unrendered here. Invoke it the same way to reach what
      // it paints; the components under test use no hooks.
      if (typeof element.type === 'function') {
        walk((element.type as (props: unknown) => unknown)(element.props));
        return;
      }
      walk(element.props.children);
    }
  }

  walk(node);
  return matches;
}

export function info(partial: Partial<SessionContextInfo> = {}): SessionContextInfo {
  return {
    contextTokens: 32_418,
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    percentage: 16,
    ...partial,
  };
}

export function render(
  props: React.ComponentProps<typeof SessionContextMetrics>
): React.ReactElement {
  // eslint-disable-next-line new-cap
  return SessionContextMetrics(props) as React.ReactElement;
}

export type TestProps = {
  testID?: string;
  className?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
  numberOfLines?: number;
  children?: unknown;
  onPress?: () => void;
  arcFraction?: number;
};

/**
 * The props of an element these tests render. The host components are mocked as
 * plain strings, so React typed them as their own prop types; the assert names
 * the handful of props an assertion reads.
 */
export function propsOf(el: React.ReactElement): TestProps {
  const props: unknown = el.props;
  return props !== null && typeof props === 'object' ? (props as TestProps) : {};
}

export function classNameOf(el: React.ReactElement): string {
  return propsOf(el).className ?? '';
}

export function pillOf(root: React.ReactElement): React.ReactElement {
  const [pill] = findAll(root, el => propsOf(el).testID === 'session-context-metrics');
  if (pill === undefined) {
    throw new Error('expected the context pill');
  }
  return pill;
}

export const PILL_LAYOUT_TOKENS = [
  'h-[44px]',
  'flex-row',
  'items-center',
  'gap-2',
  'rounded-full',
  'border',
  'border-border',
  'bg-secondary',
  'px-3',
  // The header row hands the trailing cluster a capped 50% box, but RN's
  // default flexShrink is 0. Without these the pill keeps its natural width
  // and paints past the row's right edge instead of compressing.
  'shrink',
  'min-w-0',
] as const;

export function expectHiddenPill(root: React.ReactElement): void {
  expect(root.type).toBe('View');
  const pill = pillOf(root);
  expect(classNameOf(pill)).toContain('opacity-0');
  for (const token of PILL_LAYOUT_TOKENS) {
    expect(classNameOf(pill)).toContain(token);
  }
  expect(findAll(root, el => el.type === 'ContextUsageRing').length).toBeGreaterThan(0);
  const props = propsOf(pill);
  expect(props.accessibilityElementsHidden).toBe(true);
  expect(props.importantForAccessibility).toBe('no');
}
