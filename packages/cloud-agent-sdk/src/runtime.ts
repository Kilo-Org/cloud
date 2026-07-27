export type CloudAgentSdkRuntime = {
  randomBytes(byteLength: number): Uint8Array;
  randomUUID(): string;
};

export type CloudAgentSdkRuntimeOverrides = Partial<CloudAgentSdkRuntime>;

function getGlobalCrypto(): object | undefined {
  const candidate = Reflect.get(globalThis, 'crypto');
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

function getGlobalCryptoMethod(
  methodName: 'getRandomValues' | 'randomUUID'
): ((...args: unknown[]) => unknown) | undefined {
  const globalCrypto = getGlobalCrypto();
  if (!globalCrypto) return undefined;

  const method = Reflect.get(globalCrypto, methodName);
  return typeof method === 'function' ? method : undefined;
}

function defaultRandomBytes(byteLength: number): Uint8Array {
  const globalCrypto = getGlobalCrypto();
  const getRandomValues = getGlobalCryptoMethod('getRandomValues');
  if (!globalCrypto || !getRandomValues) {
    throw new Error(
      'Cloud Agent SDK requires crypto.getRandomValues or configureCloudAgentSdkRuntime({ randomBytes }) on this platform'
    );
  }

  const bytes = new Uint8Array(byteLength);
  Reflect.apply(getRandomValues, globalCrypto, [bytes]);
  return bytes;
}

function uuidFromRandomBytes(randomBytes: (byteLength: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (bytes.byteLength < 16) {
    throw new Error('Cloud Agent SDK randomBytes must return at least 16 bytes for randomUUID');
  }

  const uuidBytes = bytes.slice(0, 16);
  const versionByte = uuidBytes[6];
  const variantByte = uuidBytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('Cloud Agent SDK randomBytes must return at least 16 bytes for randomUUID');
  }
  uuidBytes[6] = (versionByte & 0x0f) | 0x40;
  uuidBytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = Array.from(uuidBytes, byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

let hasRandomBytesOverride = false;

function defaultRandomUUID(): string {
  const globalCrypto = getGlobalCrypto();
  const randomUUID = getGlobalCryptoMethod('randomUUID');
  if (globalCrypto && randomUUID && !hasRandomBytesOverride) {
    const uuid = Reflect.apply(randomUUID, globalCrypto, []);
    if (typeof uuid === 'string') return uuid;
  }
  return uuidFromRandomBytes(cloudAgentSdkRuntime.randomBytes);
}

const defaultRuntime: CloudAgentSdkRuntime = {
  randomBytes: defaultRandomBytes,
  randomUUID: defaultRandomUUID,
};

export const cloudAgentSdkRuntime: CloudAgentSdkRuntime = {
  randomBytes: defaultRuntime.randomBytes,
  randomUUID: defaultRuntime.randomUUID,
};

export function configureCloudAgentSdkRuntime(overrides: CloudAgentSdkRuntimeOverrides): void {
  if (overrides.randomBytes) {
    cloudAgentSdkRuntime.randomBytes = overrides.randomBytes;
    hasRandomBytesOverride = true;
  }
  if (overrides.randomUUID) {
    cloudAgentSdkRuntime.randomUUID = overrides.randomUUID;
  }
}

export function resetCloudAgentSdkRuntime(): void {
  cloudAgentSdkRuntime.randomBytes = defaultRuntime.randomBytes;
  cloudAgentSdkRuntime.randomUUID = defaultRuntime.randomUUID;
  hasRandomBytesOverride = false;
}
