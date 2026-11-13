import { type TFunction } from 'i18next';

type FileErrorKey =
  | 'ssh.files.errors.network'
  | 'ssh.files.errors.permission'
  | 'ssh.files.errors.notFound'
  | 'ssh.files.errors.local'
  | 'ssh.files.errors.cancelled';

/**
 * A transfer failure, in the person's words. The core names the category; the
 * copy says what that category means for this file rather than quoting it.
 */
const ERROR_KEY = new Map<string, FileErrorKey>([
  ['Network', 'ssh.files.errors.network'],
  ['Timeout', 'ssh.files.errors.network'],
  ['ChannelClosed', 'ssh.files.errors.network'],
  ['Protocol', 'ssh.files.errors.network'],
  ['PermissionDenied', 'ssh.files.errors.permission'],
  ['NotFound', 'ssh.files.errors.notFound'],
  ['LocalIo', 'ssh.files.errors.local'],
  ['Cancelled', 'ssh.files.errors.cancelled'],
]);

export function transferErrorMessage(t: TFunction, code: string | null): string {
  const key = code === null ? undefined : ERROR_KEY.get(code);
  return t(key ?? 'ssh.files.errors.other');
}

/** A listener's failure, worded for a port forward rather than a file. */
export function forwardErrorMessage(t: TFunction, code: string | null): string {
  if (code === 'PermissionDenied') {
    return t('ssh.forwards.errors.portUnavailable');
  }
  if (code === 'Network' || code === 'Timeout' || code === 'ChannelClosed') {
    return t('ssh.session.reason.disconnected');
  }
  return t('ssh.forwards.errors.other');
}
