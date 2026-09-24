import { type ToolFailure } from '@kilocode/harness-sdk';
import { Effect } from 'effect';

import { unknownSetting } from './bindings';
import { ENTRIES } from './catalog';
import { type AppSetting, type AppSettingsService, type SettingBinding } from './types';

export type { AppSetting, AppSettingsService } from './types';

/**
 * The settings registry: the model-facing list and the read/write service over
 * the module stores the manual screens use. One source of truth — the registry
 * holds no state, so a manual change and an agent change are the same change.
 */

// The descriptors the model reads. `bind` is stripped: it is runtime wiring, not
// something a schema should carry.
export const APP_SETTINGS: readonly AppSetting[] = ENTRIES.map(
  ({ bind: _bind, ...setting }) => setting
);

/** The setting of that name, or nothing. */
export function settingNamed(name: string): AppSetting | undefined {
  return APP_SETTINGS.find(setting => setting.name === name);
}

/**
 * The read/write service bound to one organization context. The model default
 * pair reads and writes the context the chat is in; everything else is global.
 */
export function settingsService(organizationId?: string): AppSettingsService {
  const bindings = new Map(ENTRIES.map(entry => [entry.name, entry.bind(organizationId)] as const));
  const bindingFor = (name: string): Effect.Effect<SettingBinding, ToolFailure> => {
    const binding = bindings.get(name);
    return binding === undefined ? Effect.fail(unknownSetting(name)) : Effect.succeed(binding);
  };
  return {
    settings: APP_SETTINGS,
    read: name => Effect.flatMap(bindingFor(name), binding => Effect.succeed(binding.read())),
    write: (name, value) => Effect.flatMap(bindingFor(name), binding => binding.write(value)),
  };
}
