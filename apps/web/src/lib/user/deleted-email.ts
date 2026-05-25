const DELETED_USER_EMAIL_DOMAIN = 'deleted.invalid';

export function getDeletedUserEmail(userId: string): string {
  return `deleted-${userId}@${DELETED_USER_EMAIL_DOMAIN}`;
}

export function getLegacyDeletedUserEmail(userId: string): string {
  return `deleted+${userId}@${DELETED_USER_EMAIL_DOMAIN}`;
}

export function canonicalizeDeletedUserEmail(userId: string, email: string): string {
  return email === getLegacyDeletedUserEmail(userId) ? getDeletedUserEmail(userId) : email;
}
