const CALLBACK_TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type CallbackTokenParams = {
  secret: string;
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

export async function deriveCallbackToken(params: CallbackTokenParams): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(params.secret),
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

  const expectedToken = await deriveCallbackToken(params);
  return equalLengthStringsMatch(expectedToken, params.token);
}
