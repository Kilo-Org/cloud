import { base64url } from 'jose';
import type { BundleSecrets } from '../types';

/**
 * The bundle ETag is an HMAC-SHA256, under a key only the bundle object holds, over the workload
 * policy hash, every secret's manager id, version and value, and the missing names. It changes
 * whenever anything a caller would receive changes, including a value replaced under the same
 * version, and it reveals nothing about the values to anyone without the key.
 */
export async function computeBundleEtag(
  etagKey: string,
  policyHash: string,
  secrets: BundleSecrets,
  missing: readonly string[]
): Promise<string> {
  const entries = Object.keys(secrets)
    .sort()
    .map(name => {
      const secret = secrets[name];
      return [name, secret.id, secret.version, secret.value];
    });
  const material = JSON.stringify([policyHash, entries, [...missing].sort()]);
  const key = await crypto.subtle.importKey(
    'raw',
    base64url.decode(etagKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material));
  return `"${base64url.encode(new Uint8Array(mac))}"`;
}
