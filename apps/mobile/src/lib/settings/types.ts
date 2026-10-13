import { type ToolFailure } from '@kilocode/harness-sdk';
import { type Effect } from 'effect';

/**
 * The settings registry's shared shapes.
 *
 * They mirror the harness SDK's settings tool
 * (`packages/harness-sdk/src/plugins/tools/settings.ts`) exactly — name,
 * description, kind, options and destructive, and a service that carries the
 * descriptors and reads and writes one value. The SDK's built `dist` does not
 * export these yet, so a `settingsTools(service)` from the SDK accepts this
 * shape structurally; keeping the fields identical is what makes that work.
 */

/** The value forms the tool schema offers. */
type AppSettingKind = 'boolean' | 'string' | 'enum' | 'list';

/** One setting as the tool describes it to the model. */
export type AppSetting = Readonly<{
  name: string;
  description: string;
  kind: AppSettingKind;
  /** The values an `enum` setting accepts. Ignored for every other kind. */
  options?: readonly string[];
  /** Writing this setting removes something the person cannot trivially restore. */
  destructive?: boolean;
}>;

/** What the settings are, and the two things the tool may do to them. */
export type AppSettingsService = Readonly<{
  settings: readonly AppSetting[];
  read: (name: string) => Effect.Effect<unknown, ToolFailure>;
  write: (name: string, value: unknown) => Effect.Effect<string, ToolFailure>;
}>;

/** What a stored setting holds, as the registry reads it back. */
type SettingValue = boolean | string | readonly string[];

/** One setting's read/write wiring over its store. */
export type SettingBinding = Readonly<{
  write: (value: unknown) => Effect.Effect<string, ToolFailure>;
}> &
  (
    | { read: () => SettingValue; readEffect?: never }
    | {
        read?: never;
        readEffect: () => Effect.Effect<SettingValue, ToolFailure>;
      }
  );

/** A setting's descriptor plus the wiring that reaches its store. */
export type AppSettingEntry = AppSetting &
  Readonly<{ bind: (organizationId?: string) => SettingBinding }>;
