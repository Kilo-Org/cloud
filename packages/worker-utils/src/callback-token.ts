const CALLBACK_TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type CallbackTokenParams = {
  secret: string | null | undefined;
  scope: string;
  resourceParts: readonly string[];
};

export type VerifyCallbackTokenParams = CallbackTokenParams & {
  token: string | null | undefined;
};

function encodeResourceParts(resourceParts: readonly string[]): string {
  return resourceParts.map(part => `${part.length}:${part}`).join('');
}

function buildCallbackTokenMessage(params: Omit<CallbackTokenParams, 'secret'>): string {
  return `callback:v1:${params.scope}:${encodeResourceParts(params.resourceParts)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalLengthStringsMatch(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }

  return mismatch === 0;
}

function hasCallbackTokenSecret(secret: string | null | undefined): secret is string {
  return typeof secret === 'string' && secret.trim().length > 0;
}

export async function deriveCallbackToken(params: CallbackTokenParams): Promise<string> {
  const secret = params.secret;
  if (!hasCallbackTokenSecret(secret)) {
    throw new Error('Callback token secret must be configured and non-empty');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(
      buildCallbackTokenMessage({ scope: params.scope, resourceParts: params.resourceParts })
    )
  );

  return bytesToHex(new Uint8Array(signature));
}

export async function verifyCallbackToken(params: VerifyCallbackTokenParams): Promise<boolean> {
  if (!params.token || !CALLBACK_TOKEN_HEX_PATTERN.test(params.token)) {
    return false;
  }
  if (!hasCallbackTokenSecret(params.secret)) {
    return false;
  }

  const expectedToken = await deriveCallbackToken(params);
  return equalLengthStringsMatch(expectedToken, params.token);
}
