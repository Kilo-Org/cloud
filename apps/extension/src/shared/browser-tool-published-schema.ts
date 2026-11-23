import { z } from 'zod';
import { dropPathsSchema, dropTargetSchema } from './browser-agent-checks';
import type { BrowserToolContractEntry, BrowserToolInputSchema } from './browser-tool-contract';

/*
 * The input schema a model is told for one contract tool. The vendored entry is
 * published as it stands, and `src/shared/browser-tool-published-schema.ts` is
 * the one place a project rule may narrow it. The narrowing lives here and not
 * in the generated contract because that file stays the verbatim upstream
 * output — its SHA-256 is the handshake stamp a CLI compares, so a rule written
 * into it would break every client's contract check.
 *
 * `browser_drop` is the entry that is narrowed, in two properties, each of them
 * the rule every handler applies. Its `paths` entries are non-empty strings,
 * which is the rule `dropPathsSchema` states. Its `target` is a non-empty
 * string, which is the rule `dropTargetSchema` states. The `paths` item rule
 * and the `target` rule are derived from those schemas themselves, so what a
 * model reads and what the handler applies stay the same rule.
 */

const DROP_TOOL_NAME = 'browser_drop';

const DROP_PATHS_DESCRIPTION =
  'Absolute paths to files to drop onto the element. Each entry is an absolute file path, and an empty entry is not allowed.';

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** The one rule a narrowed non-empty-string property may publish: anything else means zod changed, and the rules below must be re-read. */
const nonEmptyStringRuleSchema = z.strictObject({
  minLength: z.literal(1),
  type: z.literal('string'),
});

const publishedDropPathItemRule = nonEmptyStringRuleSchema.parse(
  z.toJSONSchema(dropPathsSchema, { io: 'input' }).items
);

/*
 * `target` is published as a property, so its rule comes from an object form: a
 * lone zod schema is a document root and would carry the draft stamp beside it.
 */
const dropTargetDocument = z.toJSONSchema(z.object({ target: dropTargetSchema }), {
  io: 'input',
});

const publishedDropTargetRule = nonEmptyStringRuleSchema.parse(
  z.object({ properties: jsonObjectSchema }).parse(dropTargetDocument).properties['target']
);

const narrowDropSchema = (schema: BrowserToolInputSchema): BrowserToolInputSchema => {
  const paths = jsonObjectSchema.safeParse(schema.properties['paths']);
  const target = jsonObjectSchema.safeParse(schema.properties['target']);

  if (!paths.success || !target.success) {
    throw new Error(
      'browser_drop has no object `paths` and `target` properties in the vendored contract; ' +
        're-read the pinned tools/list before publishing a narrowed schema.'
    );
  }

  return {
    ...schema,
    properties: {
      ...schema.properties,
      paths: {
        ...paths.data,
        description: DROP_PATHS_DESCRIPTION,
        items: publishedDropPathItemRule,
      },
      target: { ...target.data, ...publishedDropTargetRule },
    },
  };
};

/** The input schema published to a model for one contract entry: the vendored one, except a narrowed `browser_drop`. */
export const publishedBrowserToolInputSchema = (
  entry: BrowserToolContractEntry
): BrowserToolInputSchema =>
  entry.name === DROP_TOOL_NAME ? narrowDropSchema(entry.inputSchema) : entry.inputSchema;
