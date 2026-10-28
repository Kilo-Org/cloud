/**
 * One transport budget for the import request. The client sends the ZIP
 * base64-encoded inside the tRPC body, so the encoded body is the outer bound:
 * base64 inflates the archive by ~4/3 and the tRPC envelope adds headroom.
 * The server enforces the encoded-length limit before decoding (chunk 3); this
 * module derives the compressed-archive cap the decoder itself enforces.
 */
export const MAX_IMPORT_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Maximum base64 string length accepted before decoding. */
export const MAX_IMPORT_ENCODED_LENGTH = MAX_IMPORT_REQUEST_BODY_BYTES;

const IMPORT_REQUEST_ENVELOPE_HEADROOM_BYTES = 256 * 1024;

/** base64 expands ~4/3, so floor(budget * 3/4) bounds the decoded archive. */
export const MAX_IMPORT_ZIP_BYTES =
  Math.floor((MAX_IMPORT_REQUEST_BODY_BYTES * 3) / 4) - IMPORT_REQUEST_ENVELOPE_HEADROOM_BYTES;

/** Total members allowed in one archive, counted before any junk or type filtering. */
export const MAX_IMPORT_ARCHIVE_ENTRIES = 1000;

/**
 * Expanded size allowed for a single archive entry, measured as the bytes the
 * decoder will allocate (the compressed size of a stored member, the
 * uncompressed size otherwise). Over-limit entries are reported, not dropped.
 */
export const MAX_IMPORT_ENTRY_EXPANDED_BYTES = 1024 * 1024;

/** Aggregate expanded size allowed for one archive; crossing it aborts the decode. */
export const MAX_IMPORT_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024;

/**
 * Per-glob bounds for `kilo.json` instruction globs. A glob over either bound
 * produces an `instruction-glob-limit` issue and is skipped, and a config with
 * more globs than {@link MAX_IMPORT_INSTRUCTION_GLOBS} keeps the first ones
 * with an `instruction-globs-exceeded` issue.
 */
export const MAX_IMPORT_INSTRUCTION_GLOBS = 32;
export const MAX_IMPORT_INSTRUCTION_GLOB_LENGTH = 256;
export const MAX_IMPORT_INSTRUCTION_GLOB_WILDCARDS = 16;

/**
 * Upper bound for `sum(glob token counts) x sum(candidate .md path lengths)`
 * during one import. Over it the instruction globs are skipped with an
 * `instruction-globs-exceeded` issue.
 */
export const MAX_IMPORT_INSTRUCTION_GLOB_WORK = 16 * 1024 * 1024;

export function isImportEncodedWithinLimit(encoded: string): boolean {
  return encoded.length <= MAX_IMPORT_ENCODED_LENGTH;
}

export function isImportArchiveWithinLimit(zipBytes: { byteLength: number }): boolean {
  return zipBytes.byteLength <= MAX_IMPORT_ZIP_BYTES;
}
