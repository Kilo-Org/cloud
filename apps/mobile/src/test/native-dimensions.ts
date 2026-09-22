// Compiles a NativeWind `className` to the native style rules Metro emits, so a
// test can assert the box a Pressable actually lays out. The on-device explorer
// measures those bounds and `hitSlop` never widens them, so a control's touch
// contract is only real when its compiled box meets it. Mirrors the compiler
// wiring in `components/ui/button.mounted.test.tsx`.
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

/**
 * Native declarations for the `min-h` / `h` / `w` / `min-w` classes in
 * `className`, compiled with the app's theme and installed compilers rather
 * than a hand-written utility-to-point map.
 */
export async function compiledDimensions(className: string) {
  const dimensions = className
    .split(' ')
    .filter(name => /^(?:min-h|min-w|h|w)-/.test(name))
    .join(' ');
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../global.css"; .target { @apply ${dimensions}; }`,
    { from: import.meta.filename }
  );
  // Match metro.config.js. The compiler keeps its default 14-point inlineRem.
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []);
}
