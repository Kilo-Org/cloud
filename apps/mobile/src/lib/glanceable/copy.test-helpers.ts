/**
 * A translator with the two behaviours the glanceable copy now relies on:
 * i18next's plural suffix selection and `{{name}}` interpolation.
 *
 * The surfaces read whole messages (`glanceable.count.*`) instead of pasting a
 * formatted number onto a noun, so a mock that returned the raw catalog value
 * would prove nothing: `{{displayCount}}` would reach the layout untouched and
 * every count would draw its `_other` form. Selecting the suffix from `count`
 * here keeps the mocks asserting the real message shape.
 */
export function copyTranslate(
  copy: Record<string, string>
): (key: string, options?: Record<string, unknown>) => string {
  return (key, options = {}) => {
    const count = typeof options.count === 'number' ? options.count : null;
    const form = count === null ? undefined : `${key}_${count === 1 ? 'one' : 'other'}`;
    const template = (form === undefined ? undefined : copy[form]) ?? copy[key] ?? key;
    return template.replaceAll(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
      const value = options[name];
      if (value === undefined) {
        return placeholder;
      }
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder;
    });
  };
}
