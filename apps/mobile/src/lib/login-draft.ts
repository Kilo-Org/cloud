import * as SecureStore from 'expo-secure-store';

import { LOGIN_EMAIL_DRAFT_KEY, LOGIN_SSO_RECOVERY_DRAFT_KEY } from '@/lib/storage-keys';

export type SsoRecoveryDraft = { email: string; ssoOrganizationId: string | undefined };

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

/** Read and clear the persisted drafts on login mount. */
export async function restoreLoginDrafts(): Promise<{
  email: string;
  ssoRecovery: SsoRecoveryDraft | null;
}> {
  const [email, ssoRaw] = await Promise.all([
    SecureStore.getItemAsync(LOGIN_EMAIL_DRAFT_KEY),
    SecureStore.getItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY),
  ]);
  await Promise.all([
    SecureStore.deleteItemAsync(LOGIN_EMAIL_DRAFT_KEY),
    SecureStore.deleteItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY),
  ]);

  let ssoRecovery: SsoRecoveryDraft | null = null;
  if (ssoRaw) {
    try {
      const parsed = JSON.parse(ssoRaw) as SsoRecoveryDraft;
      if (typeof parsed.email === 'string') {
        ssoRecovery = parsed;
      }
    } catch {
      // Corrupt draft: ignore it.
    }
  }
  return { email: email ?? '', ssoRecovery };
}

/** Drop the drafts after a successful sign-in. */
export function clearLoginDrafts(): void {
  emailDraft = '';
  ssoRecoveryDraft = null;
}
