// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

export async function nativeDimensions(className: string) {
  const dimensions = className
    .split(' ')
    .filter(token => /^(?:min-h|min-w|h|w|size)-/.test(token))
    .join(' ');
  if (!dimensions) {
    return [];
  }
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../global.css"; .target { @apply ${dimensions}; }`,
    { from: import.meta.filename }
  );
  // Match Metro, including the compiler's default 14-point inlineRem.
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
}
