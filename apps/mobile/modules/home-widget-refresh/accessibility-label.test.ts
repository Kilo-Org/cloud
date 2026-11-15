/* eslint-disable import/no-nodejs-modules -- the compile check shells out to the Swift toolchain, which only a Node test can do */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

const builderSource = readFileSync(
  new URL('ios/HomeWidgetAccessibilityLabel.swift', import.meta.url),
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

const CANDIDATES: [string, ...string[]][] = [['swiftc'], ['xcrun', 'swiftc']];

function swiftCompiler(): [string, ...string[]] | null {
  for (const candidate of CANDIDATES) {
    const [command, ...args] = candidate;
    try {
      execFileSync(command, [...args, '--version'], { stdio: 'ignore' });
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
  const bodies = [...builderSource.matchAll(/\\\(([^()]*)\)/g)].map(match =>
    (match[1] ?? '').trim()
  );
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    // A formatted count already is a String; every other interpolation must
    // read a String straight from the input.
    expect(body.startsWith('formattedCount(') || body.includes('as? String'), body).toBe(true);
  }
});

it.runIf(compiler !== null)('formats the spoken label from the locale data in the input', () => {
  const swift = compiler;
  if (swift === null) {
    throw new Error('no Swift compiler on PATH');
  }
  const [command, ...swiftArgs] = swift;
  const directory = mkdtempSync(join(tmpdir(), 'home-widget-label-'));
  const binary = join(directory, 'label-tests');
  try {
    execFileSync(command, [
      ...swiftArgs,
      '-parse-as-library',
      fileURLToPath(new URL('ios/HomeWidgetAccessibilityLabel.swift', import.meta.url)),
      fileURLToPath(new URL('tests/HomeWidgetAccessibilityLabelTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    const output = execFileSync(binary, { encoding: 'utf8' });
    expect(output).toContain('HomeWidgetAccessibilityLabel: all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
