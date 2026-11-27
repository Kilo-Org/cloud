/**
 * The mail port of the email sign-in (design 5.1, 5.3). UTS stores the sign-in email's link and
 * code hashes first, then hands the message to the port: Mailgun where the mail settings are on
 * (src/signin/email/delivery.ts), or the development entry's recording port (src/dev.ts). The
 * message carries the link and the code, nothing else about the account.
 */
export type SignInEmail = {
  to: string;
  /** The link's confirmation page on the issuer origin; its token is the link's secret. */
  link: string;
  /** Six digits, or null while sign-in codes are stopped for the address. */
  code: string | null;
  expiresAt: Date;
};

/** `retryable`: the sender did not take the message now; `failed`: it never will. */
export type MailResult = 'sent' | 'retryable' | 'failed';

export type SignInMailer = (message: SignInEmail) => Promise<MailResult>;
