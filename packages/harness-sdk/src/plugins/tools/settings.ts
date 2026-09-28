import { Effect } from 'effect';
import { type JsonSchema, type Tool, type ToolCall, ToolFailure } from '../../core/tool.js';

/**
 * The app settings, as two tools an agent may call.
 *
 * Everything a person can change by hand in a profile menu, the agent can change
 * on request — one store, so a setting changed in a chat is the setting the menu
 * shows. This module knows nothing about that store: it is given the settings and
 * how to read and write one, and turns that into a list tool and a set tool with
 * the refusals a model can act on.
 *
 * Two safety decisions are the tools' and not the service's: a destructive
 * setting asks the person first and never writes without a yes, and a call that
 * raced the group switch is refused rather than applied.
 */

/** How a setting's value is shaped, which is what decides a value is accepted. */
type AppSettingKind = 'boolean' | 'string' | 'enum' | 'list';

/** One thing a person can change. */
interface AppSetting {
  readonly name: string;
  readonly description: string;
  readonly kind: AppSettingKind;
  /** The values an `enum` setting accepts. Ignored for every other kind. */
  readonly options?: readonly string[];
  /** Writing this setting removes something the person cannot trivially restore. */
  readonly destructive?: boolean;
}

/**
 * What the settings are, and the two things the tools may do to them. A read
 * that fails is a fact about one setting and never about the list call.
 */
interface AppSettingsService {
  readonly settings: readonly AppSetting[];
  readonly read: (name: string) => Effect.Effect<unknown, ToolFailure>;
  readonly write: (name: string, value: unknown) => Effect.Effect<string, ToolFailure>;
}

/** What the caller may change about the two tools. */
interface SettingsToolsOptions {
  /**
   * Whether the tools are on, read at the moment of the call. A function, not a
   * boolean: the switch moves after the tools are built, and a call already in
   * flight has to be refused rather than applied.
   */
  readonly enabled?: () => boolean;
  /**
   * Asks the person to confirm a destructive change, and answers yes or no. The
   * summary names the setting and the value it would take. Without it, a
   * destructive setting is refused outright: nothing may change silently.
   */
  readonly confirm?: (summary: string) => Effect.Effect<boolean, unknown>;
  /** The name the model calls the list tool by, for a harness that has one. */
  readonly listName?: string;
  /** The name the model calls the set tool by, for a harness that has one. */
  readonly setName?: string;
}

/** Names, descriptions and schemas are part of the cached prefix, so they are fixed. */
const defaultListName = 'settings_list';
const defaultSetName = 'settings_set';

const turnedOff = 'The app-settings tools are turned off.';

const unconfirmed = "This setting cannot be changed without the person's confirmation.";

const listParameters: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const setParameters: JsonSchema = {
  type: 'object',
  properties: {
    setting: {
      type: 'string',
      description: 'The exact name of the setting, as settings_list gives it.',
    },
    value: {
      description:
        'The new value. A boolean setting takes true or false, a string takes a ' +
        'string, an enum takes one of the values settings_list names, and a list ' +
        'takes an array of strings.',
      type: ['boolean', 'string', 'number', 'array'],
      items: { type: 'string' },
    },
  },
  required: ['setting', 'value'],
  additionalProperties: false,
};

const listDescription =
  'Lists the app settings a person can change, one per line, with each one\u2019s ' +
  'current value. Call it before settings_set: it gives the exact setting name, ' +
  'the kind of value the setting takes, and what it is set to now.';

const setDescription =
  'Changes one app setting and answers with what changed. Call settings_list ' +
  'first, so the setting name and the value are the ones the app accepts. A ' +
  'setting marked destructive asks the person to confirm before anything is ' +
  'changed, and changes nothing when they do not.';

/** A refusal: the words are the whole of what the model can act on. */
const refuse = (cause: string): Effect.Effect<never, ToolFailure> =>
  Effect.fail(new ToolFailure({ cause }));

/** A model's arguments, read as the JSON object every tool of this shape takes. */
const isFields = (held: unknown): held is Readonly<Record<string, unknown>> =>
  typeof held === 'object' && held !== null && !Array.isArray(held);

/** The model's arguments, or a failure saying why they could not be read. */
const fieldsOf = (
  name: string,
  call: ToolCall
): Effect.Effect<Readonly<Record<string, unknown>>, ToolFailure> =>
  Effect.flatMap(
    Effect.try({
      try: (): unknown => JSON.parse(call.arguments),
      catch: cause =>
        new ToolFailure({ cause: `The arguments for ${name} are not JSON: ${String(cause)}` }),
    }),
    held =>
      isFields(held)
        ? Effect.succeed(held)
        : refuse(`The arguments for ${name} are not a JSON object.`)
  );

/** A value as the model reads it back. Nothing here is ever left blank. */
const shown = (value: unknown): string =>
  value === undefined ? 'missing' : (JSON.stringify(value) ?? 'missing');

/** A failure's own words, never a stack the provider pays for on every request. */
const wordsOf = (cause: unknown): string => {
  const fallback = cause instanceof Error ? cause.message : JSON.stringify(cause);
  return typeof cause === 'string' ? cause : (fallback ?? 'an unknown failure');
};

/** Whether a value is one the setting's kind takes. A `number` reaches no kind:
 * it is allowed by the schema so a model that sends one is told which kind the
 * setting does take, rather than being refused for a shape the schema accepted.
 */
const takes = (setting: AppSetting, value: unknown): boolean => {
  const checks: Readonly<Record<AppSettingKind, boolean>> = {
    boolean: typeof value === 'boolean',
    string: typeof value === 'string',
    enum: typeof value === 'string' && (setting.options ?? []).includes(value),
    list: Array.isArray(value) && value.every(one => typeof one === 'string'),
  };
  return checks[setting.kind];
};

/** What kind of value the setting takes, in the words the model is given back. */
const expectations: Readonly<Record<AppSettingKind, string>> = {
  boolean: 'a boolean, true or false',
  string: 'a string',
  enum: 'an enum value, one of',
  list: 'a list of strings',
};

const expects = (setting: AppSetting): string =>
  setting.kind === 'enum'
    ? `${expectations.enum} ${(setting.options ?? []).join(', ')}`
    : expectations[setting.kind];

/** The names a model may choose between, for a refusal that has to name them. */
const knownNames = (service: AppSettingsService): string => {
  const names = service.settings.map(setting => setting.name);
  return names.length === 0 ? 'none' : names.join(', ');
};

/** The parenthesised part of a list line: the kind, the choices, the warning. */
const modifiersOf = (setting: AppSetting): string =>
  [
    setting.kind,
    ...(setting.options === undefined ? [] : [`one of ${setting.options.join(', ')}`]),
    ...(setting.destructive === true ? ['destructive'] : []),
  ].join('; ');

/**
 * One line, whether the value was read or the reading failed. A failed read is
 * written into its own line and the other settings are still answered.
 */
const lineFor = (
  setting: AppSetting,
  read: Effect.Effect<unknown, ToolFailure>
): Effect.Effect<string> => {
  const ending = setting.description.endsWith('.') ? '' : '.';
  const head = `${setting.name} (${modifiersOf(setting)}) \u2014 ${setting.description}${ending} Current value: `;
  return read.pipe(
    Effect.match({
      onFailure: error => `${head}(could not be read: ${wordsOf(error.cause)})`,
      onSuccess: value => `${head}${shown(value)}`,
    })
  );
};

/** Every setting, one line each, in the order the service names them. */
const linesFor = (service: AppSettingsService): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(service.settings, setting => lineFor(setting, service.read(setting.name))),
    lines => lines.join('\n')
  );

/** Both tools refuse, rather than apply, once the group switch is off. */
const off = (
  options: SettingsToolsOptions | undefined
): Effect.Effect<never, ToolFailure> | undefined =>
  options?.enabled?.() === false ? refuse(turnedOff) : undefined;

/** The setting and value the model asked for, or a refusal naming what is wrong. */
const wanted = (
  service: AppSettingsService,
  fields: Readonly<Record<string, unknown>>
): Effect.Effect<{ readonly setting: AppSetting; readonly value: unknown }, ToolFailure> => {
  const { setting: named, value } = fields;
  const known = knownNames(service);
  if (typeof named !== 'string') {
    return refuse(`The setting name must be a string. Known settings: ${known}.`);
  }
  const setting = service.settings.find(one => one.name === named);
  if (setting === undefined) {
    return refuse(`Unknown setting "${named}". Known settings: ${known}.`);
  }
  return takes(setting, value)
    ? Effect.succeed({ setting, value })
    : refuse(
        `The value for "${setting.name}" must be ${expects(setting)}, but it was ${shown(value)}.`
      );
};

/** Asks the person about a destructive setting, and refuses when they say no. */
const agreed = (
  options: SettingsToolsOptions | undefined,
  setting: AppSetting,
  value: unknown
): Effect.Effect<void, ToolFailure> => {
  if (setting.destructive !== true) {
    return Effect.void;
  }
  const confirm = options?.confirm;
  if (confirm === undefined) {
    return refuse(unconfirmed);
  }
  return confirm(`Change "${setting.name}" to ${shown(value)}.`).pipe(
    Effect.mapError(cause => (cause instanceof ToolFailure ? cause : new ToolFailure({ cause }))),
    Effect.flatMap(yes =>
      yes
        ? Effect.void
        : refuse(`The person did not confirm the change to ${setting.name}. Nothing was changed.`)
    )
  );
};

/** The list tool: what the settings are and what each one holds. */
const listTool = (service: AppSettingsService, options?: SettingsToolsOptions): Tool => ({
  definition: {
    name: options?.listName ?? defaultListName,
    description: listDescription,
    parameters: listParameters,
  },
  run: () => off(options) ?? linesFor(service),
});

/**
 * The set tool: refuse what the service cannot take, ask the person about a
 * destructive setting, and only then write. Every refusal lands before `write`.
 */
const setTool = (service: AppSettingsService, options?: SettingsToolsOptions): Tool => {
  const name = options?.setName ?? defaultSetName;
  return {
    definition: { name, description: setDescription, parameters: setParameters },
    run: (call: ToolCall) =>
      Effect.gen(function* () {
        const stopped = off(options);
        if (stopped !== undefined) {
          return yield* stopped;
        }
        const fields = yield* fieldsOf(name, call);
        const { setting, value } = yield* wanted(service, fields);
        yield* agreed(options, setting, value);
        return yield* service.write(setting.name, value);
      }),
  };
};

/** Both tools, given a service. They are one switch, so they are returned together. */
const settingsTools = (
  service: AppSettingsService,
  options?: SettingsToolsOptions
): readonly Tool[] => [listTool(service, options), setTool(service, options)];

export type { AppSetting, AppSettingKind, AppSettingsService, SettingsToolsOptions };
export { settingsTools };
