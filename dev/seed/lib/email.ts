export function normalizeSeedEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex === -1) return trimmed;

  let local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  const plusIndex = local.indexOf('+');
  if (plusIndex !== -1) {
    local = local.slice(0, plusIndex);
  }

  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  if (isGmail) {
    local = local.replace(/\./g, '');
  }

  return `${local}@${isGmail ? 'gmail.com' : domain}`;
}
