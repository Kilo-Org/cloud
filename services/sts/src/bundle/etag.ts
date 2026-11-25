import { sha256Base64Url } from '../crypto/hash';

/**
 * The bundle ETag is a hash over the policy and every secret version in the bundle,
 * so it changes exactly when the set of versions a caller would receive changes.
 */
export async function computeBundleEtag(
  policyHash: string,
  versions: Record<string, number>
): Promise<string> {
  const lines = Object.keys(versions)
    .sort()
    .map(name => `${name}:${versions[name]}`);
  return `"${await sha256Base64Url(`${policyHash}\n${lines.join('\n')}`)}"`;
}
