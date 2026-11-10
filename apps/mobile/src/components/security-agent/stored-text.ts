// One decoder for the string fields the Security Agent panels render.
//
// `security_findings.analysis` is jsonb, and its TypeScript type is a
// compile-time annotation only: `getAnalysis` returns the stored value
// unchanged, so a record written before a field existed reaches a panel missing
// that field. A panel that reads such a field off the nominal type throws while
// rendering, and the throw costs the whole tab. A field that is absent, blank,
// or not a string is a label the panel can still show, so it decodes to `null`
// here and the caller picks the catalog copy for it.

export function storedText(value: string | null | undefined): string | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the jsonb column carries a nominal type only; a stored record can hold any JSON value at this field.
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value;
}
