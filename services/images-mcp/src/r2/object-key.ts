/**
 * Object keys are spliced into the request URL by `createR2Client`, which requires the resulting
 * request path to be exactly `/${bucket}/${key}`. Every key this service uses is built from
 * generated identifiers, so the helpers below accept the plain relative form only and refuse
 * anything else instead of normalizing it.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function scopedObjectKey(prefix: string, relativePath: string): string {
  const segments = relativePath.split('/');
  const isPlainRelativePath =
    relativePath.length > 0 &&
    !relativePath.startsWith('/') &&
    segments.every(segment => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..');

  if (!isPlainRelativePath) {
    throw new Error('Access denied: invalid source path');
  }

  return `${prefix}${relativePath}`;
}

function objectUrl(endpoint: string, bucket: string, key: string): URL {
  const expectedPath = `/${bucket}/${key}`;
  const url = new URL(expectedPath, endpoint);

  let requestPath: string;
  try {
    requestPath = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`Invalid R2 object key: ${key}`);
  }

  if (requestPath !== expectedPath) {
    throw new Error(`Invalid R2 object key: ${key}`);
  }

  return url;
}

export { scopedObjectKey, objectUrl };
