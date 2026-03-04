type JwtPayload = Record<string, unknown>;
type JwtOptions = {
  expiresIn: string;
};

type TokenUser = {
  id: string;
  api_token_pepper: string | null;
};

const JWT_TOKEN_VERSION = 3;

export async function generateApiToken(
  user: TokenUser,
  secret: string,
  environment: string
): Promise<string> {
  return signJwt(
    {
      env: environment,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      version: JWT_TOKEN_VERSION,
      internalApiUse: true,
      createdOnPlatform: 'security-agent',
    },
    secret,
    { expiresIn: '1h' }
  );
}

async function signJwt(payload: JwtPayload, secret: string, options: JwtOptions): Promise<string> {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const exp = now + parseExpiresIn(options.expiresIn);

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(
    JSON.stringify({
      ...payload,
      iat: now,
      exp,
    })
  );

  const signature = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  const encodedSignature = base64UrlEncodeBytes(new Uint8Array(signature));

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (unit === 's') {
    return value;
  }
  if (unit === 'm') {
    return value * 60;
  }
  if (unit === 'h') {
    return value * 60 * 60;
  }

  return value * 60 * 60 * 24;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const base64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
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
