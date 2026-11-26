import { base64url } from 'jose';

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}
