export type DataLayerUserHashes = {
  user_data_format: 'sha256';
  email: string;
  email_sha256: string;
  name?: string;
  name_sha256?: string;
};

export function normalizeEmailForSha256(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeNameForSha256(name: string): string {
  return name.trim().toLowerCase();
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashDataLayerUserData(input: {
  email: string;
  name?: string | null;
}): Promise<DataLayerUserHashes | null> {
  const email = normalizeEmailForSha256(input.email);

  if (!email) return null;

  const name = input.name ? normalizeNameForSha256(input.name) : '';
  const emailSha256 = await sha256Hex(email);

  if (!name) {
    return { user_data_format: 'sha256', email: emailSha256, email_sha256: emailSha256 };
  }

  const nameSha256 = await sha256Hex(name);

  return {
    user_data_format: 'sha256',
    email: emailSha256,
    email_sha256: emailSha256,
    name: nameSha256,
    name_sha256: nameSha256,
  };
}
