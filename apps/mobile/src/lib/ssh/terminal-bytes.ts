import { encodeBase64 } from '@/lib/base64';

/**
 * What the terminal module takes for one keystroke or paste.
 *
 * The native view decodes base64 itself (`sendInput`), so text is encoded as
 * UTF-8 bytes and then as that alphabet. `TextEncoder` is the runtime's UTF-8
 * encoder, which is the same byte order the pty expects.
 */
export function encodeTerminalInput(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}
