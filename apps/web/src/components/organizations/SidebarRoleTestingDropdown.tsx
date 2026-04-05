'use client';

import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { Shield, X } from 'lucide-react';
import Link from 'next/link';

const ROLE_OPTIONS: { value: OrganizationRole | 'KILO ADMIN'; label: string }[] = [
  { value: 'KILO ADMIN', label: 'Kilo Admin' },
  { value: 'owner', label: 'Owner' },
  { value: 'billing_manager', label: 'Billing Manager' },
  { value: 'member', label: 'Member' },
];

type SidebarRoleTestingDropdownProps = {
  currentRole: OrganizationRole | 'KILO ADMIN';
  originalRole: OrganizationRole;
  onRoleChange: (role: OrganizationRole | 'KILO ADMIN') => void;
  onClose: () => void;
  organizationId: string;
};

export function SidebarRoleTestingDropdown({
  currentRole,
  originalRole,
  onRoleChange,
  onClose,
  organizationId,
}: SidebarRoleTestingDropdownProps) {
  return (
    <div className="rounded-lg border border-yellow-900 bg-yellow-950/30 p-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-yellow-400">Role Testing</span>
          <button
            onClick={onClose}
            className="rounded text-yellow-400 hover:text-yellow-300 focus:ring-2 focus:ring-yellow-400 focus:ring-yellow-500 focus:outline-none"
            aria-label="Close role testing dropdown"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <select
          value={currentRole}
          onChange={e => onRoleChange(e.target.value as OrganizationRole)}
          className="bg-background text-foreground w-full rounded-md border border-yellow-700 px-2 py-1 text-xs focus:ring-2 focus:ring-yellow-400 focus:outline-none"
        >
          {ROLE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="flex items-center justify-between">
          <span className="text-xs text-yellow-500">Original: {originalRole}</span>
        </div>

        <Link
          href={`/admin/organizations/${organizationId}`}
          className="flex items-center gap-1 text-xs text-yellow-400 hover:text-yellow-300"
        >
          <Shield className="h-3 w-3" />
          Admin Dashboard
        </Link>

        <span className="text-muted-foreground text-xs">Kilo Admin-only feature</span>
      </div>
    </div>
  );
}
