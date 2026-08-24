import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { LOGIN_EMAIL_DRAFT_KEY, LOGIN_SSO_RECOVERY_DRAFT_KEY } from '@/lib/storage-keys';

export type SsoRecoveryDraft = { email: string; ssoOrganizationId: string | undefined };

const ssoRecoveryDraftSchema = z.object({
  email: z.string(),
  ssoOrganizationId: z.string().optional(),
});

let emailDraft = '';
let ssoRecoveryDraft: SsoRecoveryDraft | null = null;

/** Track the typed login email so it can be persisted before an RTL reload. */
export function setLoginEmailDraft(email: string): void {
  emailDraft = email;
}

/** Track the SSO-recovery banner so it can be persisted before an RTL reload. */
export function setSsoRecoveryDraft(recovery: SsoRecoveryDraft | null): void {
  ssoRecoveryDraft = recovery;
}

/** Write the drafts to disk so they survive an RTL language reload. */
export async function persistLoginDrafts(): Promise<void> {
  if (emailDraft.length > 0) {
    await SecureStore.setItemAsync(LOGIN_EMAIL_DRAFT_KEY, emailDraft);
  }
  if (ssoRecoveryDraft) {
    await SecureStore.setItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY, JSON.stringify(ssoRecoveryDraft));
  }
}

/** Read the persisted drafts on login mount. The caller deletes only after it
 * applies the restored values, because a cancelled mount must not lose the
 * drafts. */
export async function restoreLoginDrafts(): Promise<{
  email: string;
  ssoRecovery: SsoRecoveryDraft | null;
}> {
  const [email, ssoRaw] = await Promise.all([
    SecureStore.getItemAsync(LOGIN_EMAIL_DRAFT_KEY),
    SecureStore.getItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY),
  ]);

  let ssoRecovery: SsoRecoveryDraft | null = null;
  if (ssoRaw) {
    try {
      const parsed = ssoRecoveryDraftSchema.safeParse(JSON.parse(ssoRaw));
      if (parsed.success) {
        ssoRecovery = {
          email: parsed.data.email,
          ssoOrganizationId: parsed.data.ssoOrganizationId,
        };
      }
    } catch {
      // Corrupt draft: ignore it.
    }
  }
  return { email: email ?? '', ssoRecovery };
}

/** Delete the persisted drafts after the caller applies the restored values. */
export async function clearPersistedLoginDrafts(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LOGIN_EMAIL_DRAFT_KEY),
    SecureStore.deleteItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY),
  ]);
}

/** Drop the drafts after a successful sign-in. */
export function clearLoginDrafts(): void {
  emailDraft = '';
  ssoRecoveryDraft = null;
}
