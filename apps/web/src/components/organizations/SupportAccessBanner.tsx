import type { SupportContext } from '@kilocode/web-shared/lib/admin/support-access';

export function SupportAccessBanner({ access }: { access: SupportContext }) {
  const expires = new Date(access.expiresAt).toLocaleString();
  const isWrite = access.actionClass === 'support_write';
  return (
    <div
      role="status"
      className="border-amber-300 bg-amber-50 text-amber-950 border-b px-4 py-2 text-sm"
    >
      <strong>{isWrite ? 'Support write access' : 'Support read access'}</strong> — explicit grant{' '}
      {access.grantId.slice(0, 8)} expires {expires}. Actions are audited.
    </div>
  );
}
