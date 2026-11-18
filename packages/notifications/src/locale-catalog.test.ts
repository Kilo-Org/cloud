import { describe, expect, it } from 'vitest';

import en from './locales/en.json';
import si from './locales/si.json';

/**
 * A push catalog must parse and carry exactly the keys English defines, with the
 * same `{{placeholder}}` set per key. A catalog that drifts from `en.json`
 * resolves to English (or interpolates a broken string) on the lock screen,
 * which is easy to miss because the JSON still parses. This pins the Sinhala
 * catalog's shape and placeholders against the English source.
 */
function flatten(
  value: unknown,
  prefix = '',
  out = new Map<string, string>()
): Map<string, string> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof value === 'string') {
    out.set(prefix, value);
  }
  return out;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{([^{}]+)}}/g)].map(match => match[1]).sort();
}

const EN = flatten(en);
const SI = flatten(si);

describe('Sinhala push catalog', () => {
  it('defines exactly the English keys', () => {
    expect([...SI.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  it('keeps the English placeholders for every key', () => {
    const mismatched = [...EN.entries()]
      .filter(
        ([key, value]) =>
          placeholders(SI.get(key) ?? '').join(',') !== placeholders(value).join(',')
      )
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it('uses the compound spend-alert body the closed branch carried', () => {
    expect(SI.get('generic.body.spendAlert')).toBe('ඔබගේ වියදමට අවධානය අවශ්‍යයි');
    expect(SI.get('internal.spendAlert.title')).toBe('වියදම් අනතුරු ඇඟවීම');
    // `{{scopeName}} වියදම` mirrors the sibling `internal.lowBalance.body`
    // (`{{organizationName}} ශේෂය`) and the English `[scopeName][spend]` order.
    expect(SI.get('internal.spendAlert.body')).toBe('{{scopeName}} වියදම ${{amountUsd}} ඉක්මවා ගියේය');
  });
});
