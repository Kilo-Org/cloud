const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The bytes the terminal module takes for one keystroke or paste.
 *
 * The native view decodes base64 itself (`sendInput`, `paste`), and this app
 * carries no base64 helper of its own, so the two encodings text needs — UTF-8,
 * then base64 — live here, tested against the sequences the key bar sends.
 */
export function encodeTerminalInput(text: string): string {
  return toBase64(utf8Bytes(text));
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
      bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    } else {
      bytes.push(
        0xF0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3F),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      );
    }
  }
  return bytes;
}

function toBase64(bytes: readonly number[]): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += ALPHABET.charAt(first >> 2);
    output += ALPHABET.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4));
    output +=
      second === undefined
        ? '='
        : ALPHABET.charAt(((second & 0x0F) << 2) | ((third ?? 0) >> 6));
    output += third === undefined ? '=' : ALPHABET.charAt(third & 0x3F);
  }
  return output;
}
