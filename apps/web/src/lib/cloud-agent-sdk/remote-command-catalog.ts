/**
 * Remote CLI command catalog — strict, bounded parser owned by the SDK.
 *
 * The wire format is protocol v1. The CLI may send at most 256 commands,
 * 32 hints each, 2,000 characters per string, and a serialized payload of
 * 512 KiB measured in UTF-8 bytes. Skill-sourced commands are filtered
 * defensively; the resulting catalog is the existing `SlashCommandInfo`
 * shape consumed by the chat composer.
 */
import type { SlashCommandInfo } from './schemas';
import { remoteCommandCatalogV1Schema } from './schemas';

export {
  REMOTE_COMMAND_CATALOG_MAX_SERIALIZED_BYTES,
  REMOTE_COMMAND_MAX_COMMANDS,
  REMOTE_COMMAND_MAX_HINTS,
  REMOTE_COMMAND_MAX_STRING_LENGTH,
  remoteCommandCatalogV1Schema,
} from './schemas';
export type { RemoteCommandCatalogV1 } from './schemas';

export type RemoteCommandParseResult =
  | { ok: true; commands: SlashCommandInfo[] }
  | { ok: false; reason: 'invalid' };

/**
 * Non-fatal command-discovery state surfaced to the chat composer.
 *
 * `commands` is always present: it carries the last known valid catalog so
 * consumers can render suggestions without tracking the cache separately.
 * Successful discovery replaces it with the new catalog; transient same-owner
 * failures, loading, and idle states keep the prior valid commands. Owner
 * replacement/disconnect and malformed/oversized/upgrade-required failures
 * clear it to `[]`.
 *
 * `refresh: 'error'` indicates a transient failure that retained the prior
 * catalog; `refresh: 'upgrade-required'` indicates a relay-reported
 * `CLI_UPGRADE_REQUIRED` that requires the user to upgrade the CLI; the
 * `message` field carries the actionable copy in both cases.
 */
export type RemoteCommandState = {
  ownerConnectionId: string | null;
  refresh: 'idle' | 'loading' | 'error' | 'upgrade-required';
  commands: SlashCommandInfo[];
  message?: string;
};

/**
 * Parse a remote command catalog response from the CLI.
 *
 * Returns the trimmed `SlashCommandInfo[]` for the chat composer, or a
 * structured `invalid` result so callers can distinguish a malformed or
 * oversized payload from a transport-level failure.
 *
 * The remote schema is `.strict()` and outputs a shape that is already
 * structurally identical to `SlashCommandInfo` (the transform only filters
 * skill-sourced entries and re-emits the rest verbatim), so no per-entry
 * re-parse is needed.
 */
export function parseRemoteCommandCatalog(raw: unknown): RemoteCommandParseResult {
  const parsed = remoteCommandCatalogV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return { ok: true, commands: parsed.data.commands };
}
