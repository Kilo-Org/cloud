/**
 * Test-friendly logging helpers that suppress output during tests
 */
const isInTestMode = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
const consoleExceptInTest = (kind: 'log' | 'warn' | 'error') =>
  (isInTestMode ? () => {} : console[kind]) satisfies typeof console.log;

export const logExceptInTest = consoleExceptInTest('log');
export const warnExceptInTest = consoleExceptInTest('warn');
export const errorExceptInTest = consoleExceptInTest('error');

export function validateWorkerName(name: string): void {
  // Validate worker name
  const nameRegex = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!nameRegex.test(name)) {
    throw new Error(
      `Invalid worker name: ${name}. Must be lowercase alphanumeric with hyphens, 1-64 characters.`
    );
  }
}

/**
 * Calculate SHA-256 hash of a Buffer or string
 * @param content - Buffer or string to hash
 * @returns Full 64-character hex hash
 */
export async function calculateSHA256(content: Buffer | string): Promise<string> {
  // Convert to Uint8Array for crypto.subtle.digest
  const inputBuffer =
    typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', inputBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Get the byte size of Buffer or string content
 * @param content - Buffer or string
 * @returns Size in bytes
 */
export function getByteSize(content: Buffer | string): number {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).length;
  }
  return content.length;
}

/**
 * Get MIME type based on file extension
 * @param path - File path
 * @returns MIME type string
 */
export function getMimeType(path: string): string {
  // Remove query strings first (e.g., 'file.wasm?module' -> 'file.wasm')
  const cleanPath = path.split('?')[0];

  const ext = cleanPath.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Text
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',

    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',

    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',

    // Media
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',

    // Documents
    pdf: 'application/pdf',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',

    // Web
    wasm: 'application/wasm',
    map: 'application/json',

    // Binary
    bin: 'application/octet-stream',
  };

  return mimeTypes[ext || ''] || 'application/octet-stream';
}
