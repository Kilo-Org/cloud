type JwtPayload = Record<string, unknown>;
type JwtOptions = {
  expiresIn: string; // e.g., '1h', '15m'
};

/**
 * Sign a JWT token using HS256 algorithm.
 * This is an async implementation using Web Crypto API for Workers environment.
 */
export async function signJwt(
  payload: JwtPayload,
  secret: string,
  options: JwtOptions
): Promise<string> {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  // Calculate expiration
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = parseExpiresIn(options.expiresIn);
  const exp = now + expiresIn;

  const fullPayload = {
    ...payload,
    iat: now,
    exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  // IMPORTANT: hmacSha256 is async, must await
  const signature = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  const encodedSignature = base64UrlEncodeBuffer(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(message: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return crypto.subtle.sign('HMAC', key, messageData);
}
