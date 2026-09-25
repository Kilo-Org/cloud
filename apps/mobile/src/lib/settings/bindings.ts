import { ToolFailure } from '@kilocode/harness-sdk';
import { Effect } from 'effect';
import { z } from 'zod';

import {
  type NotificationCategoryKey,
  type NotificationPreferences,
} from '@/lib/hooks/agent-push-preference';
import { queryClient } from '@/lib/query-client';
import { trpcClient } from '@/lib/trpc';

import { type SettingBinding } from './types';

/**
 * The tRPC query key for `getNotificationPreferences`.
 *
 * tRPC's `queryKey()` for a procedure with no input is `[path]` for a filter
 * (`type: 'any'`) and `[path, { type: 'query' }]` for the query itself. Only the
 * exact form finds the cache entry the Notifications screen reads; the same
 * exact form is a valid prefix for `invalidateQueries`, so the agent's write is
 * visible on that screen without a second fetch.
 */
export const NOTIFICATION_PREFERENCES_QUERY_KEY = [
  ['user', 'getNotificationPreferences'],
  { type: 'query' },
] as const;

/** A missing cache entry is not the user's preference; fetch the server's value. */
export function readNotificationPreferences(): Effect.Effect<NotificationPreferences, ToolFailure> {
  return Effect.tryPromise({
    try: () =>
      queryClient.ensureQueryData({
        queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
        queryFn: () => trpcClient.user.getNotificationPreferences.query(),
      }),
    catch: error => failure(`Could not read notification preferences: ${String(error)}`),
  });
}

const booleanSchema = z.boolean();
const stringSchema = z.string();
const stringListSchema = z.array(z.string());

/** The value as a model reads it back, for a refusal that has to quote it. */
const shown = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));

export const failure = (message: string): ToolFailure => new ToolFailure({ cause: message });

export const invalidValue = (name: string, value: unknown, expected: string): ToolFailure =>
  failure(`${shown(value)} is not a valid value for ${name}. Expected ${expected}.`);

export const unknownSetting = (name: string): ToolFailure =>
  failure(`Unknown setting "${name}". Read the settings list and use one of its names.`);

export const changed = (name: string, value: string): string => `${name} set to ${value}`;

/** A boolean setting over a synchronous module-store writer. */
export function booleanSetting(
  name: string,
  read: () => boolean,
  write: (next: boolean) => void
): SettingBinding {
  return {
    read,
    write: value => {
      const parsed = booleanSchema.safeParse(value);
      if (!parsed.success) {
        return Effect.fail(invalidValue(name, value, 'a boolean, true or false'));
      }
      write(parsed.data);
      return Effect.succeed(changed(name, String(parsed.data)));
    },
  };
}

export type EnumSpec = Readonly<{
  name: string;
  options: readonly string[];
  read: () => string;
  write: (next: string) => void;
}>;

/** An enum setting over a synchronous module-store writer. */
export function enumSetting(spec: EnumSpec): SettingBinding {
  return {
    read: spec.read,
    write: value => {
      const parsed = stringSchema.safeParse(value);
      if (!parsed.success || !spec.options.includes(parsed.data)) {
        return Effect.fail(invalidValue(spec.name, value, `one of ${spec.options.join(', ')}`));
      }
      spec.write(parsed.data);
      return Effect.succeed(changed(spec.name, parsed.data));
    },
  };
}

/** A free-form string setting over a synchronous module-store writer. */
export function stringSetting(
  name: string,
  read: () => string,
  write: (next: string) => void
): SettingBinding {
  return {
    read,
    write: value => {
      const parsed = stringSchema.safeParse(value);
      if (!parsed.success) {
        return Effect.fail(invalidValue(name, value, 'a string'));
      }
      write(parsed.data);
      return Effect.succeed(changed(name, parsed.data));
    },
  };
}

/** A list setting, read and written as an array of strings. */
export function listSetting(
  name: string,
  read: () => string[],
  write: (next: string[]) => Promise<void>
): SettingBinding {
  return {
    read,
    write: value => {
      const parsed = stringListSchema.safeParse(value);
      if (!parsed.success) {
        return Effect.fail(invalidValue(name, value, 'a list of strings'));
      }
      return Effect.tryPromise({
        try: async () => {
          await write(parsed.data);
          return changed(name, JSON.stringify(parsed.data));
        },
        catch: error => failure(`Could not change ${name}: ${String(error)}`),
      });
    },
  };
}

/** A boolean the server owns; the write goes through tRPC and the cache is refreshed. */
export function notificationBooleanSetting(
  name: string,
  key: NotificationCategoryKey
): SettingBinding {
  return {
    readEffect: () => Effect.map(readNotificationPreferences(), preferences => preferences[key]),
    write: value => {
      const parsed = booleanSchema.safeParse(value);
      if (!parsed.success) {
        return Effect.fail(invalidValue(name, value, 'a boolean, true or false'));
      }
      const next = parsed.data;
      return Effect.tryPromise({
        try: async () => {
          await trpcClient.user.setNotificationPreferences.mutate({ [key]: next });
          await queryClient.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY });
          return changed(name, String(next));
        },
        catch: error => failure(`Could not change ${name}: ${String(error)}`),
      });
    },
  };
}
