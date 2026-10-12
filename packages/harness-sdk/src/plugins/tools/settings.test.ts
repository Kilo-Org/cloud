import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { type Tool, type ToolCall, ToolFailure } from '../../core/tool.js';
import { type AppSetting, type AppSettingsService, settingsTools } from './settings.js';

/**
 * The two app-settings tools.
 *
 * What these prove is the safety the service cannot: nothing is written for an
 * unknown setting, for a value the kind does not take, or for a destructive
 * change nobody confirmed — and nothing is written at all once the group is
 * switched off. What the tools read back is here too, because a model that
 * cannot see a setting's name and value cannot ask for the right change.
 */

const held: readonly AppSetting[] = [
  { name: 'theme', description: 'The colour scheme.', kind: 'enum', options: ['light', 'dark'] },
  { name: 'notifications', description: 'Whether the app may notify.', kind: 'boolean' },
  { name: 'history', description: 'The stored history.', kind: 'string', destructive: true },
];

const current: Readonly<Record<string, unknown>> = {
  theme: 'dark',
  notifications: true,
  history: 'kept',
};

/** A service over the fixture, recording every write it was asked to make. */
const serviceFor = (overrides: Partial<AppSettingsService> = {}) => {
  const written: (readonly [string, unknown])[] = [];
  const service: AppSettingsService = {
    settings: held,
    read: name => Effect.succeed(current[name]),
    write: (name, value) => {
      written.push([name, value]);
      return Effect.succeed(`Changed "${name}".`);
    },
    ...overrides,
  };
  return { service, written };
};

const toolOf = (tools: readonly Tool[], name: string): Tool => {
  const found = tools.find(tool => tool.definition.name === name);
  if (found === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return found;
};

const call = (name: string, args: unknown): ToolCall => ({
  id: 'tc_1',
  name,
  arguments: JSON.stringify(args),
});

const run = (tool: Tool, one: ToolCall) => Effect.runPromise(Effect.either(tool.run(one)));

/** What the model read back, or the refusal it got in its place. */
const said = async (tool: Tool, one: ToolCall): Promise<string> => {
  const got = await run(tool, one);
  expect(got._tag).toBe('Right');
  return got._tag === 'Right' ? got.right : `REFUSED: ${String(got.left.cause)}`;
};

const refused = async (tool: Tool, one: ToolCall): Promise<string> => {
  const got = await run(tool, one);
  expect(got._tag).toBe('Left');
  return got._tag === 'Left' ? String(got.left.cause) : 'not refused';
};

it('refuses an unknown setting and names the ones it knows', async () => {
  const { service, written } = serviceFor();
  const set = toolOf(settingsTools(service), 'settings_set');

  const message = await refused(set, call('settings_set', { setting: 'colour', value: 'red' }));

  expect(message).toBe('Unknown setting "colour". Known settings: theme, notifications, history.');
  expect(written).toEqual([]);
});

it('will not write a destructive setting when there is nobody to ask', async () => {
  const { service, written } = serviceFor();
  const set = toolOf(settingsTools(service), 'settings_set');

  const message = await refused(set, call('settings_set', { setting: 'history', value: 'wiped' }));

  /* No `confirm` was given, so there is no confirmation to be had and nothing
     may be changed: an agent never changes a destructive setting silently. */
  expect(message).toBe("This setting cannot be changed without the person's confirmation.");
  expect(written).toEqual([]);
});

it('changes nothing when the person declines', async () => {
  const asked: string[] = [];
  const confirm = (summary: string) => {
    asked.push(summary);
    return Effect.succeed(false);
  };
  const { service, written } = serviceFor();
  const set = toolOf(settingsTools(service, { confirm }), 'settings_set');

  const message = await refused(set, call('settings_set', { setting: 'history', value: 'wiped' }));

  expect(asked).toStrictEqual(['Change "history" to "wiped".']);
  expect(message).toBe('The person did not confirm the change to history. Nothing was changed.');
  expect(written).toEqual([]);
});

it('writes a destructive setting once the person confirms, and reports what changed', async () => {
  const asked: string[] = [];
  const confirm = (summary: string) => {
    asked.push(summary);
    return Effect.succeed(true);
  };
  const { service, written } = serviceFor();
  const set = toolOf(settingsTools(service, { confirm }), 'settings_set');

  const report = await said(set, call('settings_set', { setting: 'history', value: 'wiped' }));

  expect(asked).toStrictEqual(['Change "history" to "wiped".']);
  expect(written).toEqual([['history', 'wiped']]);
  /* The service's own report is the answer, so the model reads what changed
     rather than what it asked for. */
  expect(report).toBe('Changed "history".');
});

it('refuses both tools once the group is switched off, even for a call already in flight', async () => {
  let on = true;
  const { service, written } = serviceFor();
  const tools = settingsTools(service, { enabled: () => on });

  /* A call made while the group is on is applied... */
  expect(
    await said(
      toolOf(tools, 'settings_set'),
      call('settings_set', { setting: 'notifications', value: false })
    )
  ).toBe('Changed "notifications".');

  /* ...and a call that arrived after the switch moved is refused rather than
     applied, which is the same registry serving both. */
  on = false;
  expect(await refused(toolOf(tools, 'settings_list'), call('settings_list', {}))).toBe(
    'The app-settings tools are turned off.'
  );
  expect(
    await refused(
      toolOf(tools, 'settings_set'),
      call('settings_set', { setting: 'notifications', value: true })
    )
  ).toBe('The app-settings tools are turned off.');
  expect(written).toEqual([['notifications', false]]);
});

it('lists every setting with its name, kind and current value', async () => {
  const { service } = serviceFor();
  const list = toolOf(settingsTools(service), 'settings_list');

  const rendered = await said(list, call('settings_list', {}));

  expect(rendered).toBe(
    [
      'theme (enum; one of light, dark) \u2014 The colour scheme. Current value: "dark"',
      'notifications (boolean) \u2014 Whether the app may notify. Current value: true',
      'history (string; destructive) \u2014 The stored history. Current value: "kept"',
    ].join('\n')
  );
});

it('says so on one line when a setting cannot be read, and answers the rest', async () => {
  const { service } = serviceFor({
    read: name =>
      name === 'theme'
        ? Effect.fail(new ToolFailure({ cause: 'the store is locked' }))
        : Effect.succeed(current[name]),
  });
  const list = toolOf(settingsTools(service), 'settings_list');

  const rendered = await said(list, call('settings_list', {}));

  expect(rendered).toContain(
    'theme (enum; one of light, dark) \u2014 The colour scheme. Current value: (could not be read: the store is locked)'
  );
  expect(rendered).toContain(
    'notifications (boolean) \u2014 Whether the app may notify. Current value: true'
  );
});

it('refuses a value the setting’s kind does not take, naming the kind', async () => {
  const { service, written } = serviceFor();
  const set = toolOf(settingsTools(service), 'settings_set');

  expect(await refused(set, call('settings_set', { setting: 'theme', value: 'blue' }))).toBe(
    'The value for "theme" must be an enum value, one of light, dark, but it was "blue".'
  );
  expect(await refused(set, call('settings_set', { setting: 'notifications', value: 'yes' }))).toBe(
    'The value for "notifications" must be a boolean, true or false, but it was "yes".'
  );
  expect(await refused(set, call('settings_set', { setting: 'notifications' }))).toBe(
    'The value for "notifications" must be a boolean, true or false, but it was missing.'
  );
  expect(written).toEqual([]);
});

it('takes the names a harness gives it', () => {
  const { service } = serviceFor();

  const names = settingsTools(service, {
    listName: 'app_settings',
    setName: 'set_app_setting',
  }).map(tool => tool.definition.name);

  expect(names).toEqual(['app_settings', 'set_app_setting']);
});
