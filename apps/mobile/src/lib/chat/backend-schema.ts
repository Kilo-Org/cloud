import { z } from 'zod';

import { hasControlCharacters } from './backend-url';

export type BackendInputProblem =
  | 'invalidInput'
  | 'invalidApiKey'
  | 'invalidHeaders'
  | 'invalidUrl'
  | 'publicHttp'
  | 'httpApprovalRequired'
  | 'httpReleaseUnavailable'
  | 'staleBackend'
  | 'notLoaded';

const backendModelSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .refine(value => !hasControlCharacters(value)),
    name: z.string().trim().min(1),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    tools: z.boolean(),
    // A profile stored before the flag existed reads as text-only.
    images: z.boolean().default(false),
    // A profile stored before the flag existed sends no effort.
    reasoning: z.boolean().default(false),
  })
  .strip();

/**
 * The printable text the app sends: one rule for the key and every header value.
 * The no-break space (U+00A0) and the soft hyphen (U+00AD) are excluded because they
 * are invisible and are outside the letters, digits and standard symbols the refusal
 * copy promises.
 *
 * Only the key is trimmed, and that difference is deliberate. Surrounding whitespace
 * is never part of a credential, so a pasted key loses its edges and keeps its body
 * instead of failing on a character the person cannot see. A header value is a
 * literal the person typed for one server, so it is compared exactly as written and
 * a hidden character at its edge is named rather than stripped out of it. Both rules
 * answer the same question: the value must be printable text before it is sent.
 */
const SENDABLE_TEXT = /^[\u0020-\u007E\u00A1-\u00AC\u00AE-\u00FF]*$/;

/**
 * The set every shipped build accepted before the printable rule narrowed it, and
 * therefore the widest one a stored profile can hold. A stored read keeps it, so an
 * older profile stays listed; a save refuses what this build cannot send.
 */
const STORED_TEXT = /^[\u0020-\u007E\u0080-\u00FF]*$/;

/**
 * Names the transport sets itself, or that would rewrite the header object. The record
 * parse below drops an own `__proto__` key before any refinement runs, so the pre-parse
 * guard is what reports that key; the name stays here because it states the rule.
 */
const RESERVED_HEADER_NAMES = new Set(
  'host content-length content-type connection transfer-encoding proxy-authorization __proto__ constructor prototype'.split(
    ' '
  )
);

/** True when a pasted header value is an object that can carry header names. */
function isPastedObject(value: unknown): value is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the header object is pasted JSON, so typeof is the entry-boundary decode
  return typeof value === 'object' && value !== null;
}

/**
 * A pasted header object can carry an own `__proto__` key, and `z.record` drops it
 * while parsing: the assignment becomes a plain object's prototype instead of an
 * entry, so no rule inside the record ever sees the key and the save quietly loses
 * it. Refuse it on the raw input, before the record rewrites the object.
 */
function refuseOwnPrototypeKey(input: unknown, ctx: z.RefinementCtx) {
  if (isPastedObject(input) && Object.hasOwn(input, '__proto__')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid headers' });
  }
}

/** Header rules a stored read applies: every name rule plus the widest stored value. */
const storedBackendHeadersSchema = z
  .unknown()
  .superRefine(refuseOwnPrototypeKey)
  .pipe(z.record(z.string(), z.string()))
  .superRefine((headers, ctx) => {
    const names = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
        !STORED_TEXT.test(value) ||
        lower.startsWith('x-kilo') ||
        RESERVED_HEADER_NAMES.has(lower) ||
        names.has(lower)
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid headers' });
      }
      names.add(lower);
    }
  });

/** A save also refuses a header value outside the printable set, as it does the key. */
export const backendHeadersSchema = storedBackendHeadersSchema.refine(headers =>
  Object.values(headers).every(value => SENDABLE_TEXT.test(value))
);

/** Fields every draft shares. Only the API key and header character rules differ per mode. */
const draftFields = {
  name: z.string().trim().min(1),
  baseUrl: z.string(),
  apiKind: z.enum(['chat_completions', 'responses', 'messages']),
  completionTokenField: z
    .enum(['max_completion_tokens', 'max_tokens'])
    .default('max_completion_tokens'),
  models: z
    .array(backendModelSchema)
    .min(1)
    .refine(models => new Set(models.map(model => model.id)).size === models.length),
  allowLocalHttp: z.boolean(),
};

/** Printable text only: an invisible control is a paste mistake, not a credential. */
const apiKeySchema = z
  .string()
  .trim()
  .refine(value => SENDABLE_TEXT.test(value));
const storedApiKeySchema = z
  .string()
  .trim()
  .refine(value => STORED_TEXT.test(value));

export const draftSchema = z
  .object({ ...draftFields, apiKey: apiKeySchema, headers: backendHeadersSchema })
  .strip();
/**
 * A stored profile keeps a key or header value a tightened rule would refuse, so it
 * stays listed and can be opened and fixed; the next save applies the strict rules.
 */
export const storedDraftSchema = z
  .object({ ...draftFields, apiKey: storedApiKeySchema, headers: storedBackendHeadersSchema })
  .strip();

/** A draft can fail several fields at once and the form shows one line, so this order decides it. */
type NamedProblem = { field: string; problem: BackendInputProblem };
const NAMED_PROBLEMS: readonly NamedProblem[] = [
  { field: 'apiKey', problem: 'invalidApiKey' },
  { field: 'headers', problem: 'invalidHeaders' },
];

/**
 * The problem a failed draft names. Read the issue PATH and its code, never its
 * message: an issue can quote a credential or a custom header. A custom issue at a
 * named field's path is that field's character rule, so a value of the wrong type
 * still names no field.
 */
export function inputProblem(error: z.ZodError): BackendInputProblem {
  const named = NAMED_PROBLEMS.find(({ field }) =>
    error.issues.some(issue => issue.code === 'custom' && issue.path[0] === field)
  );
  return named?.problem ?? 'invalidInput';
}
