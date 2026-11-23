import { z } from 'zod';
import {
  dropPathsSchema,
  dropTargetSchema,
  webMcpCallArgumentsSchema,
} from './browser-agent-checks';
import type { BrowserToolContractEntry, BrowserToolInputSchema } from './browser-tool-contract';

/*
 * What a model is told for one contract tool. The vendored entry is published
 * as it stands, and this module is the one place a project rule may narrow it.
 * The narrowing lives here and not in the generated contract because that file
 * stays the verbatim upstream output — its SHA-256 is the handshake stamp a CLI
 * compares, so a rule written into it would break every client's contract check.
 *
 * Three entries are narrowed, each to the rule every handler applies:
 *
 * - `browser_drop`'s `paths` entries are non-empty strings (`dropPathsSchema`),
 *   and its `target` is a non-empty string (`dropTargetSchema`).
 * - `browser_webmcp_call` takes a tool name and its params (`webMcpCallArgumentsSchema`),
 *   so the vendored `frame` argument is no longer advertised; no handler reads
 *   it, and the session refuses it by name.
 * - `browser_webmcp_list` reads the tools the tab's top-level document
 *   registers, so its published description does not claim a cross-frame list.
 *
 * Every rule is derived from the schema the handler parses, so what a model
 * reads and what the tool accepts stay the same rule.
 */

const DROP_TOOL_NAME = 'browser_drop';
const WEBMCP_CALL_TOOL_NAME = 'browser_webmcp_call';
const WEBMCP_LIST_TOOL_NAME = 'browser_webmcp_list';

const DROP_PATHS_DESCRIPTION =
  'Absolute paths to files to drop onto the element. Each entry is an absolute file path, and an empty entry is not allowed.';

/** The vendored wording claims a cross-frame list; discovery runs in the tab's top-level document. */
const WEBMCP_LIST_DESCRIPTION = "List the WebMCP tools the page's top-level document registers";

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A vendored property whose description the narrowed copy keeps verbatim. */
const describedPropertySchema = z.object({ description: z.string() }).catchall(z.unknown());

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

/** The `name`/`params` rules the `browser_webmcp_call` handler parses, as a model reads them. */
const publishedWebMcpCallProperties = z
  .object({ properties: jsonObjectSchema })
  .parse(z.toJSONSchema(webMcpCallArgumentsSchema, { io: 'input' })).properties;

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

const narrowWebMcpCallSchema = (schema: BrowserToolInputSchema): BrowserToolInputSchema => {
  const name = describedPropertySchema.safeParse(schema.properties['name']);
  const params = describedPropertySchema.safeParse(schema.properties['params']);

  if (!name.success || !params.success) {
    throw new Error(
      'browser_webmcp_call has no described `name` and `params` properties in the vendored contract; ' +
        're-read the pinned tools/list before publishing a narrowed schema.'
    );
  }

  return {
    ...schema,
    properties: {
      name: {
        ...jsonObjectSchema.parse(publishedWebMcpCallProperties['name']),
        description: name.data.description,
      },
      params: {
        ...jsonObjectSchema.parse(publishedWebMcpCallProperties['params']),
        description: params.data.description,
      },
    },
  };
};

/** The input schema published to a model for one contract entry: the vendored one, except a narrowed entry. */
export const publishedBrowserToolInputSchema = (
  entry: BrowserToolContractEntry
): BrowserToolInputSchema => {
  if (entry.name === DROP_TOOL_NAME) {
    return narrowDropSchema(entry.inputSchema);
  }

  if (entry.name === WEBMCP_CALL_TOOL_NAME) {
    return narrowWebMcpCallSchema(entry.inputSchema);
  }

  return entry.inputSchema;
};

/** The tool description published to a model for one contract entry: the vendored one, except a corrected `browser_webmcp_list`. */
export const publishedBrowserToolDescription = (entry: BrowserToolContractEntry): string =>
  entry.name === WEBMCP_LIST_TOOL_NAME ? WEBMCP_LIST_DESCRIPTION : entry.description;
