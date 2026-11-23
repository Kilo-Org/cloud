import { z } from 'zod';
import { dropPathsSchema } from './browser-agent-checks';
import type { BrowserToolContractEntry, BrowserToolInputSchema } from './browser-tool-contract';

/*
 * The input schema a model is told for one contract tool. The vendored entry is
 * published as it stands, and `src/shared/browser-tool-published-schema.ts` is
 * the one place a project rule may narrow it. The narrowing lives here and not
 * in the generated contract because that file stays the verbatim upstream
 * output — its SHA-256 is the handshake stamp a CLI compares, so a rule written
 * into it would break every client's contract check.
 *
 * `browser_drop` is the entry that is narrowed. Its `paths` entries are
 * non-empty strings, which is the rule `dropPathsSchema` states and every
 * handler applies. The published item rule is derived from `dropPathsSchema`
 * itself, so what a model reads and what the handler applies stay the same
 * rule.
 */

const DROP_TOOL_NAME = 'browser_drop';

const DROP_PATHS_DESCRIPTION =
  'Absolute paths to files to drop onto the element. Each entry is an absolute file path, and an empty entry is not allowed.';

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** The one item rule `dropPathsSchema` may publish: anything else means zod changed, and the rule below must be re-read. */
const dropPathItemRuleSchema = z.strictObject({
  minLength: z.literal(1),
  type: z.literal('string'),
});

const publishedDropPathItemRule = dropPathItemRuleSchema.parse(
  z.toJSONSchema(dropPathsSchema, { io: 'input' }).items
);

const narrowDropPaths = (schema: BrowserToolInputSchema): BrowserToolInputSchema => {
  const paths = jsonObjectSchema.safeParse(schema.properties['paths']);

  if (!paths.success) {
    throw new Error(
      'browser_drop has no object `paths` property in the vendored contract; re-read the pinned ' +
        'tools/list before publishing a narrowed schema.'
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
    },
  };
};

/** The input schema published to a model for one contract entry: the vendored one, except a narrowed `browser_drop`. */
export const publishedBrowserToolInputSchema = (
  entry: BrowserToolContractEntry
): BrowserToolInputSchema =>
  entry.name === DROP_TOOL_NAME ? narrowDropPaths(entry.inputSchema) : entry.inputSchema;
