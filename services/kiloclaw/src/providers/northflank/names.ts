const NORTHFLANK_NAME_PREFIX = 'kc';
const NORTHFLANK_STRICT_MAX_LENGTH = 39;

async function hashHex(input: string, bytes: number): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer).slice(0, bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sanitizeNameFragment(input: string): string {
  return input
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isValidNorthflankName(name: string, maxLength: number): boolean {
  return name.length <= maxLength && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(name);
}

export async function northflankNameFromKey(
  key: string,
  maxLength = NORTHFLANK_STRICT_MAX_LENGTH
): Promise<string> {
  const sanitized = sanitizeNameFragment(key);
  const readableName = sanitized ? `${NORTHFLANK_NAME_PREFIX}-${sanitized}` : '';
  if (readableName && isValidNorthflankName(readableName, maxLength)) {
    return readableName;
  }

  return `${NORTHFLANK_NAME_PREFIX}-${await hashHex(key, 12)}`;
}

export type NorthflankResourceNames = {
  projectName: string;
  serviceName: string;
  volumeName: string;
  secretName: string;
};

export async function northflankResourceNames(key: string): Promise<NorthflankResourceNames> {
  const name = await northflankNameFromKey(key);
  return {
    projectName: name,
    serviceName: name,
    volumeName: name,
    secretName: name,
  };
}
