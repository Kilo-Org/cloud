import * as z from 'zod';

/**
 * Per alert, not per organization: one address may be configured on any number
 * of alerts, and this bound is what the alert-period delivery admission cap
 * mirrors.
 */
export const MAX_ORGANIZATION_ALERT_RECIPIENTS = 10;

/**
 * Shown by the editor and returned by the API for the same rejection, so the
 * client and the server cannot describe the disclosure requirement differently.
 */
export const RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE =
  'Confirm that every recipient may receive the organization name and its measured month-to-date AI usage spend.';

/** Practical maximum length of an email address. */
const MAX_ORGANIZATION_ALERT_RECIPIENT_LENGTH = 320;

/**
 * Case- and whitespace-normalization used for recipient identity. Kept separate
 * from the schema so hashing a persisted address cannot depend on validation
 * succeeding.
 */
export function normalizeOrganizationAlertRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

/** Normalizes one recipient for identity: trimmed, lowercased, and validated. */
export const OrganizationAlertRecipientSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z.email({ message: 'Enter a valid email address' }).max(MAX_ORGANIZATION_ALERT_RECIPIENT_LENGTH)
  );

/**
 * Recipients as persisted: normalized, deduplicated, then bounded, so the cap
 * counts distinct identities. A disabled alert may keep zero recipients so a
 * disclosure configuration is never trapped.
 */
export const OrganizationAlertRecipientsSchema = z
  .array(OrganizationAlertRecipientSchema)
  .transform(recipients => [...new Set(recipients)])
  .refine(recipients => recipients.length <= MAX_ORGANIZATION_ALERT_RECIPIENTS, {
    message: `An alert may have at most ${MAX_ORGANIZATION_ALERT_RECIPIENTS} distinct recipient email addresses`,
  });

/** An enabled alert must be able to notify at least one recipient. */
export const EnabledOrganizationAlertRecipientsSchema = OrganizationAlertRecipientsSchema.refine(
  recipients => recipients.length > 0,
  { message: 'Add at least one recipient email address' }
);
