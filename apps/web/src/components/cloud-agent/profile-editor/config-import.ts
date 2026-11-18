/** Client-side helpers for the local config import flow. */
import { parseLocalConfigArchive, type ImportPreview } from '@kilocode/cloud-agent-profile/import';

const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Base64-encode the archive for the tRPC transport without spreading a whole
 * multi-megabyte archive into one `String.fromCharCode` call.
 */
export function encodeArchiveBody(archive: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < archive.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...archive.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/**
 * Decode the archive in the browser so the preview can render before the
 * server responds. The server re-decodes the same bytes authoritatively.
 */
export function decodeArchiveLocally(archive: Uint8Array): ImportPreview {
  return parseLocalConfigArchive(archive);
}

export type SelectionGuard = {
  /** Start a selection and return its token. */
  begin(): number;
  /** Whether `token` still belongs to the active selection. */
  isCurrent(token: number): boolean;
  /** Drop the active selection so any pending response is ignored. */
  invalidate(): void;
};

/**
 * Guards one import selection at a time. `begin` returns a token that
 * `isCurrent` checks when a preview or apply response arrives, so a superseded
 * archive can never write its result over the displayed selection; `invalidate`
 * drops the active selection on reset.
 */
export function createSelectionGuard(): SelectionGuard {
  let current = 0;
  return {
    begin: () => (current += 1),
    isCurrent: token => token === current,
    invalidate: () => {
      current += 1;
    },
  };
}
