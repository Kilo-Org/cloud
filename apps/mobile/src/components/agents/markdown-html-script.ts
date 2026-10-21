// Unicode has sub- and superscript forms for digits, signs, parentheses and a
// few letters. `H<sub>2</sub>O` and `x<sup>2</sup>` become plain text that the
// native markdown renders on the same baseline as its line, with no offset
// view for iOS to clip. Content outside these forms stays HTML.
const SUPERSCRIPT: ReadonlyMap<string, string> = new Map([
  ['0', '⁰'],
  ['1', '¹'],
  ['2', '²'],
  ['3', '³'],
  ['4', '⁴'],
  ['5', '⁵'],
  ['6', '⁶'],
  ['7', '⁷'],
  ['8', '⁸'],
  ['9', '⁹'],
  ['+', '⁺'],
  ['-', '⁻'],
  ['\u2212', '⁻'],
  ['=', '⁼'],
  ['(', '⁽'],
  [')', '⁾'],
  ['i', 'ⁱ'],
  ['n', 'ⁿ'],
]);
const SUBSCRIPT: ReadonlyMap<string, string> = new Map([
  ['0', '₀'],
  ['1', '₁'],
  ['2', '₂'],
  ['3', '₃'],
  ['4', '₄'],
  ['5', '₅'],
  ['6', '₆'],
  ['7', '₇'],
  ['8', '₈'],
  ['9', '₉'],
  ['+', '₊'],
  ['-', '₋'],
  ['\u2212', '₋'],
  ['=', '₌'],
  ['(', '₍'],
  [')', '₎'],
  ['a', 'ₐ'],
  ['e', 'ₑ'],
  ['h', 'ₕ'],
  ['k', 'ₖ'],
  ['l', 'ₗ'],
  ['m', 'ₘ'],
  ['n', 'ₙ'],
  ['o', 'ₒ'],
  ['p', 'ₚ'],
  ['s', 'ₛ'],
  ['t', 'ₜ'],
  ['x', 'ₓ'],
]);

/** `text` in sub- or superscript characters; null when any character has no such form. */
export function toScriptText(text: string, kind: 'sub' | 'sup'): string | null {
  const forms = kind === 'sup' ? SUPERSCRIPT : SUBSCRIPT;
  let scripted = '';
  for (const character of text) {
    const form = forms.get(character);
    if (form === undefined) {
      return null;
    }
    scripted += form;
  }
  return scripted === '' ? null : scripted;
}
