export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

export function resolveNotificationEmails(emails: string[], pendingEmail: string): string[] | null {
  const trimmedEmail = pendingEmail.trim();

  if (!trimmedEmail) return emails;
  if (!isValidEmail(trimmedEmail)) return null;
  if (emails.includes(trimmedEmail)) return emails;

  return [...emails, trimmedEmail];
}
