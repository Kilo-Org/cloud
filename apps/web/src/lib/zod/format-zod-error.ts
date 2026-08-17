import { z } from 'zod';

export type ZodIssueLike =
  | z.core.$ZodIssue
  | {
      code: string;
      message?: string;
      path?: readonly PropertyKey[];
      keys?: string[];
      errors?: readonly (readonly ZodIssueLike[])[];
    };

export function formatZodIssue(
  issue: ZodIssueLike,
  parentPath: readonly (string | number | symbol)[] = []
): string {
  const fullPath = [...parentPath, ...(issue.path ?? [])];
  const pathStr = fullPath.length > 0 ? fullPath.map(String).join('.') : '';

  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length > 0) {
    const keysStr = issue.keys.map(k => `"${k}"`).join(', ');
    const label = issue.keys.length === 1 ? 'Unrecognized key' : 'Unrecognized keys';
    return pathStr ? `${pathStr}: ${label}: ${keysStr}` : `${label}: ${keysStr}`;
  }

  const message = issue.message || 'Invalid input';
  return pathStr ? `${pathStr}: ${message}` : message;
}

export function formatZodIssues(
  issues: readonly ZodIssueLike[],
  parentPath: readonly (string | number | symbol)[] = []
): string[] {
  const messages: string[] = [];

  for (const issue of issues) {
    const currentPath = [...parentPath, ...(issue.path ?? [])];

    if (issue.code === 'invalid_union' && Array.isArray(issue.errors) && issue.errors.length > 0) {
      const branchIssueLists = issue.errors;
      const minErrors = Math.min(...branchIssueLists.map(list => list.length));
      const candidateBranches = branchIssueLists.filter(list => list.length === minErrors);

      if (candidateBranches.length === 1) {
        messages.push(...formatZodIssues(candidateBranches[0], currentPath));
      } else {
        const branchMessages = new Set<string>();
        for (const branch of candidateBranches) {
          for (const msg of formatZodIssues(branch, currentPath)) {
            branchMessages.add(msg);
          }
        }
        messages.push(...Array.from(branchMessages));
      }
      continue;
    }

    messages.push(formatZodIssue(issue, parentPath));
  }

  return messages;
}

export function formatZodError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const lines = formatZodIssues(error.issues as ZodIssueLike[]);
    return lines.length > 0 ? lines.join('\n') : error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof (error as { data?: unknown }).data === 'object' &&
    (error as { data?: { zodError?: unknown } }).data?.zodError
  ) {
    const zodError = (
      error as {
        data: {
          zodError: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
        };
      }
    ).data.zodError;

    const messages: string[] = [];
    if (Array.isArray(zodError.formErrors)) {
      for (const msg of zodError.formErrors) {
        if (msg && msg !== 'Invalid input') messages.push(msg);
      }
    }
    if (zodError.fieldErrors && typeof zodError.fieldErrors === 'object') {
      for (const [field, fieldMessages] of Object.entries(zodError.fieldErrors)) {
        if (Array.isArray(fieldMessages)) {
          for (const msg of fieldMessages) {
            messages.push(`${field}: ${msg}`);
          }
        }
      }
    }
    if (messages.length > 0) {
      return messages.join('\n');
    }
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.code) {
          const lines = formatZodIssues(parsed as ZodIssueLike[]);
          if (lines.length > 0) return lines.join('\n');
        }
      } catch {
        // Not JSON
      }
    }
    return error;
  }

  if (error instanceof Error) {
    return formatZodError(error.message);
  }

  return 'Validation failed';
}
