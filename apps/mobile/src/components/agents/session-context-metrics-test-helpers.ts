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
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as { children?: unknown };
      walk(props.children);
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

export function expectHiddenReservedBox(root: React.ReactElement): void {
  expect(root.type).toBe('View');
  const className = (root.props as { className?: string }).className ?? '';
  expect(className).toContain('opacity-0');
  for (const token of PILL_LAYOUT_TOKENS) {
    expect(className).toContain(token);
  }
  expect(findAll(root, el => el.type === 'ContextUsageRing').length).toBeGreaterThan(0);
  const props = root.props as {
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  };
  expect(props.accessibilityElementsHidden).toBe(true);
  expect(props.importantForAccessibility).toBe('no');
}

/** Asserts the pill body renders exactly one text child holding the dash. */
export function expectDashLabel(root: React.ReactElement): void {
  const texts = findAll(root, el => el.type === 'Text');
  expect(texts).toHaveLength(1);
  const dash = texts[0];
  if (dash == null) {
    throw new Error('expected the dash label');
  }
  expect((dash.props as { children?: unknown }).children).toBe('—');
}
