'use client';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UserSearchInput } from './UserSearchInput';
import { X, Filter } from 'lucide-react';

interface OrganizationFiltersProps {
  search: string;
  onSearchChange: (searchTerm: string) => void;
  isLoading: boolean;
  seatsRequired?: string;
  hasBalance?: string;
  status?: string;
  plan?: string;
  onSeatsRequiredChange: (value: string) => void;
  onHasBalanceChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onPlanChange: (value: string) => void;
  onResetFilters: () => void;
  totalCount?: number;
  filteredCount?: number;
}

export function OrganizationFilters({
  search,
  onSearchChange,
  isLoading,
  seatsRequired,
  hasBalance,
  status,
  plan,
  onSeatsRequiredChange,
  onHasBalanceChange,
  onStatusChange,
  onPlanChange,
  onResetFilters,
  totalCount,
  filteredCount,
}: OrganizationFiltersProps) {
  const activeFiltersCount = [
    seatsRequired,
    hasBalance,
    status !== 'all',
    plan && plan !== 'all',
  ].filter(Boolean).length;
  const hasActiveFilters = activeFiltersCount > 0;

  return (
    <div className="space-y-4">
      {/* Filter Controls Row */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Main Search - Leftmost */}
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

        {/* Seats Required Filter */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Seats Required</Label>
          <Select
            value={seatsRequired || 'all'}
            onValueChange={value => onSeatsRequiredChange(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Has Balance Filter */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Has Balance</Label>
          <Select
            value={hasBalance || 'all'}
            onValueChange={value => onHasBalanceChange(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Status Filter */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Status</Label>
          <Select value={status || 'all'} onValueChange={value => onStatusChange(value)}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Subscribed</SelectItem>
              <SelectItem value="deleted">Deleted</SelectItem>
              <SelectItem value="incomplete">Unsubscribed</SelectItem>
            </SelectContent>
          </Select>
        </div>

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

        {/* Reset Filters Button */}
        {hasActiveFilters && (
          <div className="space-y-2">
            <Label className="text-sm font-medium opacity-0">Reset</Label>
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
          {/* Active Filters Badges */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2">
              <Filter className="text-muted-foreground h-4 w-4" />
              <span className="text-muted-foreground text-sm">Active filters:</span>
              {seatsRequired && (
                <Badge variant="secondary" className="text-xs">
                  Seats Required: {seatsRequired === 'true' ? 'Yes' : 'No'}
                  <button
                    onClick={() => onSeatsRequiredChange('')}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {hasBalance && (
                <Badge variant="secondary" className="text-xs">
                  Has Balance: {hasBalance === 'true' ? 'Yes' : 'No'}
                  <button
                    onClick={() => onHasBalanceChange('')}
                    className="hover:bg-secondary-foreground/20 ml-1 rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {status && status !== 'all' && (
                <Badge variant="secondary" className="text-xs">
                  Status:{' '}
                  {status === 'active'
                    ? 'Subscribed'
                    : status.charAt(0).toUpperCase() + status.slice(1)}
                  <button
                    onClick={() => onStatusChange('all')}
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
            </div>
          )}

          {/* Results Count */}
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
