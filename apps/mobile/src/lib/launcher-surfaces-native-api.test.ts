/* eslint-disable import/no-nodejs-modules -- vitest-only guard, reads Kotlin sources under Node, never bundled into the app */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Source-contract guard for the Android launcher-surfaces module.
//
// Android Lint's NewApi check is the usual guard for a framework call above the
// app's minSdk: an unguarded call throws NoSuchMethodError on the oldest
// supported device instead of failing a build. This repository does not run
// lint on the native projects (its classpath cannot resolve offline:
// com.android.tools.lint:lint-gradle:31.12.0 is not in the Gradle cache) and
// mobile-native-build.yml only runs `:app:assembleDebug`, so nothing else
// catches it. The API levels below come from the installed SDK's own database,
// $ANDROID_HOME/platforms/android-36/data/api-versions.xml
// (`setLongLived(Z) ... since=29`, `startActivityAndCollapse ... since=34`),
// which is identical in the android-35 copy.
const ANDROID_MIN_SDK = 24;

const ABOVE_MIN_SDK_CALLS = [
  { symbol: 'setLongLived', minApi: 29 },
  { symbol: 'startActivityAndCollapse', minApi: 34 },
] as const;

const KOTLIN_PACKAGE_DIR = fileURLToPath(
  new URL(
    '../../modules/kilo-launcher-surfaces/android/src/main/java/com/kilocode/kilaunchersurfaces',
    import.meta.url
  )
);

const API_GUARD = /Build\.VERSION\.SDK_INT\s*>=\s*(\d+)/;

type SourceLine = { number: number; text: string };

/** A trimmed Kotlin comment line: line, block-body or block-open. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Code lines only, each with its 1-based number in the file. */
function codeLines(source: string): SourceLine[] {
  return source
    .split('\n')
    .map((text, index) => ({ number: index + 1, text }))
    .filter(line => !isCommentLine(line.text));
}

/** The `fun ` line enclosing a call, or -1 when none precedes it. */
function enclosingFunctionIndex(lines: SourceLine[], callIndex: number): number {
  return lines.findLastIndex((line, index) => index < callIndex && line.text.includes('fun '));
}

/** The level of a `Build.VERSION.SDK_INT >= N` guard, or undefined. */
function guardLevel(text: string): number | undefined {
  const level = API_GUARD.exec(text)?.at(1);
  return level === undefined ? undefined : Number(level);
}

describe('Android launcher-surfaces API-level contract', () => {
  const kotlinFiles = readdirSync(KOTLIN_PACKAGE_DIR).filter(name => name.endsWith('.kt'));

  it('scans every Kotlin file in the launcher-surfaces package', () => {
    // A new file added to the package must not escape the scan below.
    expect(kotlinFiles).toContain('KiloLauncherSurfacesModule.kt');
    expect(kotlinFiles).toContain('QuickSettingsTileService.kt');
    expect(kotlinFiles).toContain('LauncherSurfacesStore.kt');
  });

  it.each(ABOVE_MIN_SDK_CALLS)(
    'guards $symbol (API $minApi) with Build.VERSION.SDK_INT in its function',
    ({ symbol, minApi }) => {
      const unguarded: string[] = [];
      for (const file of kotlinFiles) {
        const lines = codeLines(readFileSync(join(KOTLIN_PACKAGE_DIR, file), 'utf8'));
        const calls = lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.text.includes(symbol));
        for (const { line, index } of calls) {
          const functionIndex = enclosingFunctionIndex(lines, index);
          const guarded =
            functionIndex !== -1 &&
            lines
              .slice(functionIndex + 1, index)
              .some(candidate => (guardLevel(candidate.text) ?? 0) >= minApi);
          if (!guarded) {
            unguarded.push(`${file}:${line.number} ${symbol}`);
          }
        }
      }
      expect(unguarded, `${symbol} is API ${minApi}, above minSdk ${ANDROID_MIN_SDK}`).toEqual([]);
    }
  );
});
