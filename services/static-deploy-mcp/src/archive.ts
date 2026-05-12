/**
 * Utilities for building tar.gz archives from HTML strings or ZIP files.
 * Uses only Web-standard APIs (CompressionStream, DecompressionStream) — no external dependencies.
 */

const FORBIDDEN_EXTENSIONS = new Set([
  '.php',
  '.py',
  '.rb',
  '.pl',
  '.sh',
  '.bash',
  '.cgi',
  '.asp',
  '.aspx',
  '.jsp',
  '.cfm',
]);

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB total

/** A single file entry ready to be archived. */
type FileEntry = { name: string; content: Uint8Array };

/** Build a tar.gz from a raw HTML string, producing a single index.html file. */
export async function tarGzFromHtml(html: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return createTarGz([{ name: 'index.html', content: encoder.encode(html) }]);
}

/**
 * Parse a base64-encoded ZIP archive and re-pack it as a tar.gz.
 * Validates:
 *  - index.html exists at the root
 *  - no server-side file extensions
 *  - total size stays below MAX_UNCOMPRESSED_BYTES
 */
export async function tarGzFromZip(base64Zip: string): Promise<Uint8Array> {
  const zipData = base64ToUint8Array(base64Zip);
  const files = await unzip(zipData);
  validateFiles(files);
  return createTarGz(files);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function validateFiles(files: FileEntry[]): void {
  const rootNames = new Set(files.map(f => f.name.split('/')[0]));

  // If every file is under a single top-level directory, treat that directory
  // as the root (common when tools zip a folder).
  let prefix = '';
  if (rootNames.size === 1) {
    const candidate = [...rootNames][0];
    const allUnder = files.every(f => f.name.startsWith(candidate + '/'));
    if (allUnder) prefix = candidate + '/';
  }

  const hasIndex = files.some(f => f.name === prefix + 'index.html');
  if (!hasIndex) {
    throw new Error(
      prefix
        ? `No index.html found under ${prefix} in the ZIP archive`
        : 'No index.html found at the root of the ZIP archive'
    );
  }

  let totalBytes = 0;
  for (const file of files) {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      throw new Error(`File "${file.name}" has a disallowed extension for a static site (${ext})`);
    }
    totalBytes += file.content.byteLength;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Archive exceeds the ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MB limit`);
    }
  }

  // Strip the single top-level directory if present, so index.html ends up at root
  if (prefix) {
    for (const file of files) {
      file.name = file.name.slice(prefix.length);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (no external library)
// Supports stored (method 0) and deflate (method 8) entries.
// ---------------------------------------------------------------------------

async function unzip(data: Uint8Array): Promise<FileEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Locate End-of-Central-Directory record (signature 0x06054b50, little-endian)
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65558); i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file (EOCD not found)');

  const centralDirCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const files: FileEntry[] = [];
  let cdPos = centralDirOffset;

  for (let i = 0; i < centralDirCount; i++) {
    // Central directory entry: signature 0x02014b50
    if (view.getUint32(cdPos, false) !== 0x504b0102) {
      throw new Error(`Invalid central directory entry at offset ${cdPos}`);
    }

    const compression = view.getUint16(cdPos + 10, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const fileNameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const name = new TextDecoder().decode(data.slice(cdPos + 46, cdPos + 46 + fileNameLen));
    cdPos += 46 + fileNameLen + extraLen + commentLen;

    // Skip directory entries
    if (name.endsWith('/')) continue;

    // Read local file header to find the actual data offset
    if (view.getUint32(localHeaderOffset, false) !== 0x504b0304) {
      throw new Error(`Invalid local file header for "${name}"`);
    }
    const lfhFileNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + lfhFileNameLen + lfhExtraLen;

    const compressed = data.slice(dataStart, dataStart + compressedSize);

    let content: Uint8Array;
    if (compression === 0) {
      // Stored — no compression
      content = compressed;
    } else if (compression === 8) {
      // DEFLATE (raw)
      content = await decompressRaw(compressed, uncompressedSize);
    } else {
      throw new Error(`ZIP entry "${name}" uses unsupported compression method ${compression}`);
    }

    files.push({ name, content });
  }

  return files;
}

async function decompressRaw(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write all compressed data then close
  const writePromise = writer.write(data).then(() => writer.close());

  // Collect decompressed chunks
  const chunks: Uint8Array[] = [];
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  await Promise.all([writePromise, readPromise]);

  const result = new Uint8Array(expectedSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// TAR + gzip builder
// Uses POSIX ustar format; gzip via Web CompressionStream API.
// ---------------------------------------------------------------------------

function createTarEntry(name: string, content: Uint8Array, mtime: number): Uint8Array {
  const encoder = new TextEncoder();
  const header = new Uint8Array(512); // all zeros by default

  function writeStr(offset: number, maxLen: number, str: string): void {
    const bytes = encoder.encode(str);
    header.set(bytes.slice(0, maxLen), offset);
  }

  writeStr(0, 100, name); // name
  writeStr(100, 8, '0000644\0'); // mode
  writeStr(108, 8, '0000000\0'); // uid
  writeStr(116, 8, '0000000\0'); // gid
  writeStr(124, 12, content.length.toString(8).padStart(11, '0') + '\0'); // size
  writeStr(136, 12, mtime.toString(8).padStart(11, '0') + '\0'); // mtime
  header.fill(32, 148, 156); // checksum placeholder = 8 spaces
  header[156] = 48; // typeflag '0' = regular file
  writeStr(257, 6, 'ustar '); // magic
  header[263] = 32; // version ' '
  header[264] = 0; //           '\0'

  // Compute checksum over all 512 bytes (checksum field already contains spaces)
  let sum = 0;
  for (const b of header) sum += b;

  // Store checksum as 6-digit octal + null + space
  const cksumStr = sum.toString(8).padStart(6, '0');
  writeStr(148, 6, cksumStr);
  header[154] = 0;
  header[155] = 32;

  // Pad content to the next 512-byte boundary
  const paddedLen = Math.ceil(content.length / 512) * 512;
  const paddedContent = new Uint8Array(paddedLen);
  paddedContent.set(content);

  const entry = new Uint8Array(512 + paddedLen);
  entry.set(header, 0);
  entry.set(paddedContent, 512);
  return entry;
}

async function createTarGz(files: FileEntry[]): Promise<Uint8Array> {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Uint8Array[] = files.map(f => createTarEntry(f.name, f.content, mtime));
  parts.push(new Uint8Array(1024)); // end-of-archive marker

  // Concatenate all parts into a single tar buffer
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const tar = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }

  // Gzip-compress the tar using the Web Compression Streams API
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  const writePromise = writer.write(tar).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  await Promise.all([writePromise, readPromise]);

  const gzipLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(gzipLen);
  let gzipOffset = 0;
  for (const chunk of chunks) {
    result.set(chunk, gzipOffset);
    gzipOffset += chunk.length;
  }
  return result;
}
