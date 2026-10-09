import { sha256Hex } from '@kilocode/worker-utils/sha256';

export { sha256Hex };

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
