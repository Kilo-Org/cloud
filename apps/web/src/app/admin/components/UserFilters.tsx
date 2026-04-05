'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { UserSearchInput } from './UserSearchInput';

interface UserFiltersProps {
  search: string;
  onSearchChange: (searchTerm: string) => void;
  hasValidationStytch: string;
  hasValidationNovelCard: string;
  onHasValidationStytchChange: (value: string) => void;
  onHasValidationNovelCardChange: (value: string) => void;
  blockedStatus: string;
  onBlockedStatusChange: (value: string) => void;
  orgMembership: string;
  onOrgMembershipChange: (value: string) => void;
  paymentStatus: string;
  onPaymentStatusChange: (value: string) => void;
  autoTopUp: string;
  onAutoTopUpChange: (value: string) => void;
  notesSearch: string;
  onNotesSearchChange: (searchTerm: string) => void;
  isLoading: boolean;
}

export function UserFilters({
  search,
  onSearchChange,
  hasValidationStytch,
  hasValidationNovelCard,
  onHasValidationStytchChange,
  onHasValidationNovelCardChange,
  blockedStatus,
  onBlockedStatusChange,
  orgMembership,
  onOrgMembershipChange,
  paymentStatus,
  onPaymentStatusChange,
  autoTopUp,
  onAutoTopUpChange,
  notesSearch,
  onNotesSearchChange,
  isLoading,
}: UserFiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      {/* Main Search - Leftmost */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Search Users</Label>
        <div className="w-80">
          <UserSearchInput
            value={search}
            onChange={onSearchChange}
            isLoading={isLoading}
            placeholder="by email/name/ID/referral-code/safety-id..."
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Notes & Blocked Reason</Label>
        <div className="w-60">
          <UserSearchInput
            value={notesSearch}
            onChange={onNotesSearchChange}
            isLoading={isLoading}
            placeholder="substring search..."
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="stytch-filter" className="text-sm font-medium">
          Stytch Validation
        </Label>
        <Select value={hasValidationStytch} onValueChange={onHasValidationStytchChange}>
          <SelectTrigger id="stytch-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="true">Has Validation</SelectItem>
            <SelectItem value="false">No Validation</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="blocked-status-filter" className="text-sm font-medium">
          Blocked Status
        </Label>
        <Select value={blockedStatus} onValueChange={onBlockedStatusChange}>
          <SelectTrigger id="blocked-status-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
            <SelectItem value="not_blocked">Not Blocked</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="org-membership-filter" className="text-sm font-medium">
          Organization
        </Label>
        <Select value={orgMembership} onValueChange={onOrgMembershipChange}>
          <SelectTrigger id="org-membership-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="in_org">In Organization</SelectItem>
            <SelectItem value="not_in_org">Not in Organization</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="payment-status-filter" className="text-sm font-medium">
          Payment Status
        </Label>
        <Select value={paymentStatus} onValueChange={onPaymentStatusChange}>
          <SelectTrigger id="payment-status-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="paid">Has Paid</SelectItem>
            <SelectItem value="never_paid">Never Paid</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="auto-top-up-filter" className="text-sm font-medium">
          Auto Top-Up
        </Label>
        <Select value={autoTopUp} onValueChange={onAutoTopUpChange}>
          <SelectTrigger id="auto-top-up-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="novel-card-filter" className="text-sm font-medium">
          Novel Card Validation
        </Label>
        <Select value={hasValidationNovelCard} onValueChange={onHasValidationNovelCardChange}>
          <SelectTrigger id="novel-card-filter" className="w-40">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="true">Has Validation</SelectItem>
            <SelectItem value="false">No Validation</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
