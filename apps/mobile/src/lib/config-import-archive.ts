/**
 * Build the config archive the profile import procedures take.
 *
 * The server decodes a base64 ZIP (`agent-profiles-router.ts`'s
 * `previewConfigImport`/`applyConfigImport`), so a config the reader pastes as
 * text travels inside one. The archive is written with `fflate`, the library
 * the server decodes with, so both sides agree on the format without a
 * hand-rolled encoder here.
 */

import { strToU8, zipSync } from 'fflate';

/** The config file name the server treats as a config root (`import/archive.ts`). */
export const CONFIG_ARCHIVE_FILE_NAME = 'kilo.json';

/**
 * Longest pasted config this app will package. A real `kilo.json` is a few
 * kilobytes; the archive budget still refuses anything the server would.
 */
export const MAX_CONFIG_IMPORT_TEXT_LENGTH = 1024 * 1024;

/** Server budget: `MAX_IMPORT_ENCODED_LENGTH` in `import/limits.ts`. */
const MAX_CONFIG_IMPORT_ENCODED_LENGTH = 8 * 1024 * 1024;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode `bytes` without a platform helper: neither `btoa` nor `Buffer`
 * is guaranteed on every runtime the app runs on, and the encoding has to be
 * byte-identical for the server's decoder.
 */
function base64FromBytes(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const triple =
      (bytes[index] ?? 0) * 65536 + (bytes[index + 1] ?? 0) * 256 + (bytes[index + 2] ?? 0);
    output += BASE64_ALPHABET.charAt(Math.floor(triple / 262144) % 64);
    output += BASE64_ALPHABET.charAt(Math.floor(triple / 4096) % 64);
    output += index + 1 < bytes.length ? BASE64_ALPHABET.charAt(Math.floor(triple / 64) % 64) : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET.charAt(triple % 64) : '=';
  }
  return output;
}

/** Why a pasted config cannot be sent. */
type ConfigImportArchiveError = 'empty' | 'too-large';

export type ConfigImportArchiveResult =
  | { readonly ok: true; readonly archive: string }
  | { readonly ok: false; readonly error: ConfigImportArchiveError };

/**
 * Package pasted config text as the base64 archive the import procedures take.
 * The pasted `kilo.json` becomes the archive's only member, which is the shape
 * the web uploader produces for a config directory holding one file.
 */
export function configImportArchiveFromText(text: string): ConfigImportArchiveResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty' };
  }
  if (trimmed.length > MAX_CONFIG_IMPORT_TEXT_LENGTH) {
    return { ok: false, error: 'too-large' };
  }
  const archive = base64FromBytes(
    zipSync({ [CONFIG_ARCHIVE_FILE_NAME]: strToU8(trimmed) }, { level: 0 })
  );
  if (archive.length > MAX_CONFIG_IMPORT_ENCODED_LENGTH) {
    return { ok: false, error: 'too-large' };
  }
  return { ok: true, archive };
}
