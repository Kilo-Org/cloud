import type * as z from 'zod';

/** Per-caller details for `addDuplicateKeyIssues`. */
export type DuplicateKeyIssue = {
  /** Leading path segments; the repeated entry's array index follows them. */
  pathPrefix?: readonly (string | number)[];
  /** Message for a key that already appeared earlier in the array. */
  message: (key: string) => string;
};

// One implementation of "flag each entry whose key already appeared earlier",
// reported at the later index. Callers own their key, path prefix and wording,
// because those are the admin-facing 400 details of each schema.
export function addDuplicateKeyIssues<T>(
  entries: readonly T[],
  ctx: z.RefinementCtx,
  keyOf: (entry: T) => string,
  issue: DuplicateKeyIssue
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const key = keyOf(entry);
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [...(issue.pathPrefix ?? []), index],
        message: issue.message(key),
      });
    }
    seen.add(key);
  });
}
