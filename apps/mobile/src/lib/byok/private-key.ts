/**
 * The PEM labels a key the gateway can sign with carries, spelled exactly.
 *
 * The label is matched against these rather than by its last words: an encrypted
 * PKCS#8 key is labelled `ENCRYPTED PRIVATE KEY`, so a suffix check would take
 * it, and the gateway holds no passphrase to open it.
 */
const SIGNING_KEY_LABELS: ReadonlySet<string> = new Set([
  'PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
]);

/**
 * The PEM label a passphrase-protected PKCS#8 key carries. It is a complete key
 * block the gateway still cannot sign with, because it holds no passphrase, so
 * reading it as a malformed value would tell its reader to paste what they
 * already pasted.
 */
const ENCRYPTED_KEY_LABEL = 'ENCRYPTED PRIVATE KEY';

/**
 * The header a key encrypted in the older PEM style carries inside one of the
 * signing labels: `Proc-Type: 4,ENCRYPTED` and a matching `DEK-Info` line. It is
 * the same passphrase-protected case under a different label.
 */
const LEGACY_ENCRYPTED_HEADER = /^[ \t]*Proc-Type:[ \t]*4,[ \t]*ENCRYPTED/im;

/**
 * Why a pasted Vertex private key is not one the gateway can sign with: the
 * value is not a complete key block, or it is a complete block a passphrase
 * protects, which the gateway cannot open. A complete encrypted block is
 * otherwise well formed, and telling its reader to paste the whole block names
 * what they already pasted, so the two cases need their own sentences.
 */
export type PrivateKeyCause = 'key-block' | 'key-encrypted';

type PrivateKeyRead =
  | { readonly tag: 'key'; readonly pem: string }
  | { readonly tag: 'refused'; readonly cause: PrivateKeyCause };

/**
 * A service-account private key in the shape the gateway signs with, or why the
 * value is not one.
 *
 * The key is pasted as a whole value into a single-line field, and a paste can
 * arrive with its line breaks folded away or escaped by the JSON file it came
 * from: a downloaded key file stores the key as one JSON string, so copying the
 * value out of it yields the two characters `\` and `n` where a line break was.
 * Base64 does not need the breaks, so the wrapping is put back here. The result
 * is the same value whether the reader pasted a file, a folded copy of it, or
 * the escaped string from a downloaded key, so the gateway never receives a key
 * it cannot parse.
 *
 * This checks the PEM's shape and not its contents: the DER inside is the
 * gateway's to read, and the app has no parser for it. What it does catch is the
 * value that is not a PEM at all, which the credential shape accepts (it only
 * asks for a non-empty string) and which would otherwise be stored and fail at
 * the first request that tries to sign. The label has to be one of the three a
 * signing key carries; an encrypted key — which needs a passphrase the gateway
 * does not have — is refused here as well, with its own cause.
 */
export function canonicalPrivateKey(value: string): PrivateKeyRead {
  const typed = value
    .replaceAll(String.raw`\r\n`, '\n')
    .replaceAll(String.raw`\n`, '\n')
    .trim();
  const match = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*)-----END ([A-Z0-9 ]+)-----$/.exec(typed);
  if (!match) {
    return { tag: 'refused', cause: 'key-block' };
  }
  const [, beginLabel, rawBody, endLabel] = match;
  if (beginLabel === undefined || rawBody === undefined || beginLabel !== endLabel) {
    return { tag: 'refused', cause: 'key-block' };
  }
  if (beginLabel === ENCRYPTED_KEY_LABEL || LEGACY_ENCRYPTED_HEADER.test(rawBody)) {
    return { tag: 'refused', cause: 'key-encrypted' };
  }
  if (!SIGNING_KEY_LABELS.has(beginLabel)) {
    return { tag: 'refused', cause: 'key-block' };
  }
  const body = rawBody.replaceAll(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    return { tag: 'refused', cause: 'key-block' };
  }
  const lines = body.match(/.{1,64}/g);
  if (!lines) {
    return { tag: 'refused', cause: 'key-block' };
  }
  return {
    tag: 'key',
    pem: [`-----BEGIN ${beginLabel}-----`, ...lines, `-----END ${beginLabel}-----`].join('\n'),
  };
}
