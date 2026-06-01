'use client';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UserSearchInput } from './UserSearchInput';
import { X, Filter } from 'lucide-react';

import {
  STRIPE_SUBSCRIPTION_STATUSES,
  getStripeStatusLabel,
} from '@/lib/admin/stripe-subscription-statuses';

interface OrganizationFiltersProps {
  search: string;
  onSearchChange: (searchTerm: string) => void;
  isLoading: boolean;
  includeDeleted: boolean;
  stripeStatus: string;
  plan: string;
  hasUsage: boolean;
  hasMultipleUsers: boolean;
  showStripeStatus?: boolean;
  showTrialFilters?: boolean;
  onIncludeDeletedChange: (value: boolean) => void;
  onStripeStatusChange: (value: string) => void;
  onPlanChange: (value: string) => void;
  onHasUsageChange: (value: boolean) => void;
  onHasMultipleUsersChange: (value: boolean) => void;
  onResetFilters: () => void;
  totalCount?: number;
  filteredCount?: number;
}

export function OrganizationFilters({
  search,
  onSearchChange,
  isLoading,
  includeDeleted,
  stripeStatus,
  plan,
  hasUsage,
  hasMultipleUsers,
  showStripeStatus = true,
  showTrialFilters = false,
  onIncludeDeletedChange,
  onStripeStatusChange,
  onPlanChange,
  onHasUsageChange,
  onHasMultipleUsersChange,
  onResetFilters,
  totalCount,
  filteredCount,
}: OrganizationFiltersProps) {
  const hasActiveFilters =
    includeDeleted ||
    !!stripeStatus ||
    (!!plan && plan !== 'all') ||
    (showTrialFilters && (hasUsage || hasMultipleUsers));

  const stripeStatusLabel = stripeStatus ? getStripeStatusLabel(stripeStatus) : undefined;

  return (
    <div className="space-y-4">
      {/* Filter Controls Row */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Main Search */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Search Organizations</Label>
          <div className="w-80">
            <UserSearchInput
              value={search}
              onChange={onSearchChange}
              isLoading={isLoading}
              placeholder="by name/ID/Stripe customer..."
            />
          </div>
        </div>

        {/* Stripe Status Filter */}
        {showStripeStatus && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Stripe Status</Label>
            <Select
              value={stripeStatus || 'all'}
              onValueChange={value => onStripeStatusChange(value === 'all' ? '' : value)}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                {STRIPE_SUBSCRIPTION_STATUSES.map(s => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Plan Filter */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Plan</Label>
          <Select
            value={plan || 'all'}
            onValueChange={value => onPlanChange(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
              <SelectItem value="teams">Teams</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Include Deleted Checkbox */}
        <div className="flex items-center gap-2 pb-1">
          <Checkbox
            id="include-deleted"
            checked={includeDeleted}
            onCheckedChange={checked => onIncludeDeletedChange(checked === true)}
          />
          <Label htmlFor="include-deleted" className="cursor-pointer text-sm font-medium">
            Include deleted
          </Label>
        </div>

        {/* Trial-tab filters */}
        {showTrialFilters && (
          <>
            <div className="flex items-center gap-2 pb-1">
              <Checkbox
                id="has-usage"
                checked={hasUsage}
                onCheckedChange={checked => onHasUsageChange(checked === true)}
              />
              <Label htmlFor="has-usage" className="cursor-pointer text-sm font-medium">
                Usage &gt; 0
              </Label>
            </div>
            <div className="flex items-center gap-2 pb-1">
              <Checkbox
                id="has-multiple-users"
                checked={hasMultipleUsers}
                onCheckedChange={checked => onHasMultipleUsersChange(checked === true)}
              />
              <Label htmlFor="has-multiple-users" className="cursor-pointer text-sm font-medium">
                Users &gt; 1
              </Label>
            </div>
          </>
        )}

        {/* Reset Filters Button */}
        {hasActiveFilters && (
          <div className="pb-1">
            <Button variant="outline" size="sm" onClick={onResetFilters} className="h-9">
              <X className="mr-1 h-4 w-4" />
              Reset Filters
            </Button>
          </div>
        )}
      </div>

      {/* Active Filters and Count Display */}
      {(hasActiveFilters || (totalCount !== undefined && filteredCount !== undefined)) && (
        <div className="flex items-center justify-between">
          {hasActiveFilters && (
            <div className="flex items-center gap-2">
              <Filter className="text-muted-foreground h-4 w-4" />
              <span className="text-muted-foreground text-sm">Active filters:</span>
              {stripeStatus && (
                <Badge variant="secondary" className="text-xs">
                  Status: {stripeStatusLabel ?? stripeStatus}
                  <button
                    onClick={() => onStripeStatusChange('')}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {plan && plan !== 'all' && (
                <Badge variant="secondary" className="text-xs">
                  Plan: {plan.charAt(0).toUpperCase() + plan.slice(1)}
                  <button
                    onClick={() => onPlanChange('')}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {includeDeleted && (
                <Badge variant="secondary" className="text-xs">
                  Includes deleted
                  <button
                    onClick={() => onIncludeDeletedChange(false)}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {showTrialFilters && hasUsage && (
                <Badge variant="secondary" className="text-xs">
                  Usage &gt; 0
                  <button
                    onClick={() => onHasUsageChange(false)}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {showTrialFilters && hasMultipleUsers && (
                <Badge variant="secondary" className="text-xs">
                  Users &gt; 1
                  <button
                    onClick={() => onHasMultipleUsersChange(false)}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
            </div>
          )}

          {totalCount !== undefined && filteredCount !== undefined && (
            <div className="text-muted-foreground text-sm">
              Showing {filteredCount.toLocaleString()} of {totalCount.toLocaleString()}{' '}
              organizations
            </div>
          )}
        </div>
      )}
    </div>
  );
}
