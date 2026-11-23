import { type TFunction } from 'i18next';

import { type McpFormError } from '@/components/profiles/profile-mcp-model';

/** Catalog key for each refused field, so the message lands under the input at fault. */
export const ERROR_KEYS = {
  'name-required': 'profiles.mcp.nameRequired',
  'name-invalid': 'profiles.mcp.nameInvalid',
  'name-conflict': 'profiles.mcp.nameConflict',
  'command-required': 'profiles.mcp.commandRequired',
  'command-too-long': 'profiles.mcp.commandTooLong',
  'url-required': 'profiles.mcp.urlRequired',
  'url-invalid': 'profiles.mcp.urlInvalid',
  'url-too-long': 'profiles.mcp.urlTooLong',
  'timeout-invalid': 'profiles.mcp.timeoutInvalid',
  'json-invalid': 'profiles.mcp.jsonInvalid',
  'record-too-large': 'profiles.mcp.jsonTooLarge',
} satisfies Record<McpFormError, string>;

/** The field each refused input belongs to, so Save can scroll it into view. */
export const FIELD_FOR_ERROR = {
  'name-required': 'name',
  'name-invalid': 'name',
  'name-conflict': 'name',
  'command-required': 'command',
  'command-too-long': 'command',
  'url-required': 'url',
  'url-invalid': 'url',
  'url-too-long': 'url',
  'timeout-invalid': 'timeout',
  'json-invalid': 'config',
  'record-too-large': 'config',
} satisfies Record<McpFormError, 'name' | 'command' | 'url' | 'config' | 'timeout'>;

/** The message for a refusal that belongs to one of `match`'s fields. */
export function errorKeyFor(
  t: TFunction,
  error: McpFormError | null,
  match: readonly McpFormError[]
): string | undefined {
  return error !== null && match.includes(error) ? t(ERROR_KEYS[error]) : undefined;
}
