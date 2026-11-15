import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

const builderSource = readFileSync(
  new URL('./ios/HomeWidgetAccessibilityLabel.swift', import.meta.url),
  'utf8'
);

// The widget target compiles this file alone, so it must not reach for a UI,
// security or Expo module, and it must not call a formatter or read a bundle.
// Every localized string arrives in the input dictionary instead.
const FORBIDDEN_MODULES = [
  'UIKit',
  'WidgetKit',
  'SwiftUI',
  'Security',
  'ExpoModulesCore',
  'NumberFormatter',
  'Bundle',
] as const;

function swiftCompiler(): string[] | null {
  for (const candidate of [['swiftc'], ['xcrun', 'swiftc']]) {
    try {
      execFileSync(candidate[0], [...candidate.slice(1), '--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const compiler = swiftCompiler();

it('keeps the builder free of UI, storage and formatter dependencies', () => {
  expect(builderSource).toContain('import Foundation');
  for (const forbidden of FORBIDDEN_MODULES) {
    expect(builderSource, forbidden).not.toContain(forbidden);
  }
});

it('formats every number through the helper before it reaches the text', () => {
  expect(builderSource).not.toContain('joined(separator: ", ")');
  const bodies = [...builderSource.matchAll(/\\\(([^()]*)\)/g)].map(match => (match[1] ?? '').trim());
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    // A formatted count already is a String; every other interpolation must
    // read a String straight from the input.
    expect(body.startsWith('formattedCount(') || body.includes('as? String'), body).toBe(true);
  }
});

it.runIf(compiler !== null)('formats the spoken label from the locale data in the input', () => {
  const swift = compiler;
  if (!swift) throw new Error('no Swift compiler on PATH');
  const directory = mkdtempSync(join(tmpdir(), 'home-widget-label-'));
  const binary = join(directory, 'label-tests');
  try {
    execFileSync(swift[0] ?? 'swiftc', [
      ...swift.slice(1),
      '-parse-as-library',
      fileURLToPath(new URL('./ios/HomeWidgetAccessibilityLabel.swift', import.meta.url)),
      fileURLToPath(new URL('./tests/HomeWidgetAccessibilityLabelTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    const output = execFileSync(binary, { encoding: 'utf8' });
    expect(output).toContain('HomeWidgetAccessibilityLabel: all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
