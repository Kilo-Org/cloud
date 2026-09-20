import { isValidElement, type ReactNode } from 'react';
import { I18nManager, type TextStyle } from 'react-native';

/**
 * RN 0.86 does not resolve `textAlign: 'auto'` from the native layout
 * direction on iOS, so text that fills its box stays left-aligned in an RTL
 * interface while the flexbox around it mirrors correctly. Naming the
 * paragraph's base direction makes the natural alignment resolve, and unlike
 * `textAlign` it leaves an explicit `text-center` alone.
 *
 * `@/components/ui/text` applies this to everything that goes through it.
 * The markdown renderer builds its `Text` nodes with `createElement` and its
 * own computed styles, so it reaches for the same constant rather than
 * inheriting the component.
 */
export const RTL_WRITING_DIRECTION: TextStyle = { writingDirection: 'rtl' };

/**
 * Letter-spacing — Tailwind's `tracking-*` — is a Latin typographic device:
 * it opens every glyph from its neighbour. The RTL scripts the app ships do
 * not take it. An Arabic-script word is one connected shape, so a tracked
 * label breaks its joins and renders the letters as isolated forms
 * ('استكشف'); a letter-spacing of 0 keeps the paragraph's natural spacing.
 *
 * `@/components/ui/text` applies this to everything that goes through it, in
 * the same RTL style array as `RTL_WRITING_DIRECTION`, so a tracked class the
 * LTR design owns stays in the className and simply has no effect in RTL.
 */
export const RTL_NO_LETTER_SPACING: TextStyle = { letterSpacing: 0 };

/**
 * Arabic and its script relatives, including the Arabic Supplement and the
 * presentation-form blocks a translated label may use.
 */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** True when any string among `node` and its descendants is written in Arabic. */
export function hasArabicScript(node: ReactNode): boolean {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      if (hasArabicScript(child)) {
        return true;
      }
    }
    return false;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode primitive-arm check; no non-typeof discriminant separates a text child from an element
  if (typeof node === 'string') {
    return ARABIC_SCRIPT.test(node);
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return hasArabicScript(props.children);
  }
  return false;
}

/**
 * The mono family utilities of `global.css`. JetBrains Mono is a Latin design
 * and ships no Arabic glyphs, so Android draws an Arabic word through a
 * fallback one character at a time and every letter comes out in its isolated
 * form ('ا س ت ك ش ف'); the system font the rest of the screen uses keeps the
 * joins. A label that stays tracked and uppercase still reads correctly, so
 * only the family is dropped.
 */
const MONO_FAMILY_CLASS = /^(?:[a-z-]+:)*font-mono(?:-(?:medium|semibold))?$/;

/** `className` without the Latin-only mono family utilities. */
export function withoutMonoFamily(className: string): string {
  return className
    .split(' ')
    .filter(token => !MONO_FAMILY_CLASS.test(token))
    .join(' ');
}

/** The caller's style with the RTL paragraph direction behind it, in RTL only. */
export function withRtlWritingDirection(style: TextStyle | undefined): TextStyle | undefined {
  if (!I18nManager.isRTL) {
    return style;
  }
  return style ? { ...RTL_WRITING_DIRECTION, ...style } : RTL_WRITING_DIRECTION;
}
