import { type NoticeDeps, deliverClaimed } from './dispatch';

// mirrors uts-pat src/account/routes.ts; one copy after merge
/** What a created credential's owner hears about it by push and email (design 5.13). */
export type CredentialNotice = {
  kind: 'pat_created' | 'bot_key_created';
  accountId: string;
  credentialId: string;
};

// mirrors uts-pat src/account/routes.ts; one copy after merge
/**
 * Sends the push and email notice of a created credential. The create statement already wrote the
 * in-app notice row, which the security page always shows; null where no notice provider is wired.
 */
export type CredentialNotices = (notice: CredentialNotice) => Promise<void>;

/**
 * The account API's notice port: claims the `credential_created` notice that the create statement
 * wrote for this credential and delivers it. A notice that another round already claimed or
 * delivered is left alone. A provider failure leaves the notice pending for the background pass;
 * an identity-store failure rejects, and the account route logs it without failing the create.
 */
export function credentialNotices(deps: NoticeDeps): CredentialNotices {
  return async notice => {
    const credential = notice.kind === 'pat_created' ? 'pat' : 'bot_key';
    const claimed = await deps.notices(store =>
      store.claimCredentialNotice(notice.accountId, credential, notice.credentialId)
    );
    if (claimed !== null) await deliverClaimed(deps, claimed);
  };
}
