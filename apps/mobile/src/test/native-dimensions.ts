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

async function compiledDeclarations(classes: string) {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../global.css"; .target { @apply ${classes}; }`,
    { from: import.meta.filename }
  );
  // Match metro.config.js. The compiler keeps its default 14-point inlineRem.
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
}

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
  const declarations = await compiledDeclarations(dimensions);
  return declarations;
}

/**
 * The dp `className` compiles `property` to — e.g. the `paddingBlock` a row's
 * `py-1.5` sets, which `compiledDimensions` does not cover. Theme lengths
 * compile to `calc(var(--spacing, <dp>) * n)`, and the compiler bakes the
 * app's 14-point rem into that fallback, so following it gives the dp the
 * control lays out.
 */
export async function compiledLengthDp(className: string, property: string): Promise<number> {
  const declarations = await compiledDeclarations(className);
  for (const declaration of declarations) {
    if (Array.isArray(declaration)) {
      const [value, names] = declaration;
      const declared = Array.isArray(names) ? names : [names];
      if (declared.includes(property)) {
        return compiledLength(value);
      }
    } else {
      const declared = declaration[property];
      if (typeof declared === 'number') {
        return declared;
      }
    }
  }
  throw new Error(`no compiled "${property}" declaration for "${className}"`);
}

/** Resolves a compiled length descriptor, following var fallbacks and calc. */
function compiledLength(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`cannot resolve compiled length ${JSON.stringify(value)}`);
  }
  // A descriptor is either one term ([guards, kind, ...]) or a list of terms.
  const term = (value[1] === 'var' || value[1] === 'calc' ? value : value[0]) as unknown[];
  if (term[1] === 'var') {
    // `var(--name, <fallback>)`: the fallback is the dp the compiler baked in.
    return compiledLength((term[2] as [string, unknown])[1]);
  }
  if (term[1] === 'calc') {
    return compiledCalc(term[2] as unknown[]);
  }
  throw new Error(`cannot resolve compiled length ${JSON.stringify(value)}`);
}

function compiledCalc(expression: unknown[]): number {
  let total = compiledLength(expression[0]);
  for (let index = 1; index + 1 < expression.length; index += 2) {
    const operator = expression[index];
    const operand = compiledLength(expression[index + 1]);
    if (operator === '*') {
      total *= operand;
    } else if (operator === '/') {
      total /= operand;
    } else if (operator === '+') {
      total += operand;
    } else if (operator === '-') {
      total -= operand;
    } else {
      throw new Error(`unsupported calc operator ${String(operator)}`);
    }
  }
  return total;
}
