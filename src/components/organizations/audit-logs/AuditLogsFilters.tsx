'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Search, Filter, ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import type { AuditLogAction } from '@/lib/organizations/organization-audit-logs';
import type { AuditLogsFilters } from './useAuditLogsFilters';

type AuditLogsFiltersProps = {
  filters?: AuditLogsFilters;
  onFilterChange?: <K extends keyof AuditLogsFilters>(key: K, value: AuditLogsFilters[K]) => void;
  onClearFilters?: () => void;
  availableActions?: AuditLogAction[];
};

export function AuditLogsFilters({
  filters,
  onFilterChange,
  onClearFilters,
  availableActions,
}: AuditLogsFiltersProps) {
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const hasActiveFilters = !!(
    (filters?.action && filters.action.length > 0) ||
    filters?.actorEmail ||
    filters?.startTime ||
    filters?.endTime
  );

  return (
    <>
      <style jsx>{`
        input[type='date']::-webkit-calendar-picker-indicator,
        input[type='time']::-webkit-calendar-picker-indicator {
          filter: invert(0.5);
          opacity: 0.7;
        }
      `}</style>
      <div className="space-y-4">
        {/* Header with search and filter toggle */}
        <div className="flex items-center justify-between">
          {/* Always visible search */}
          <div className="relative w-64">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Search logs..."
              value={filters?.fuzzySearch || ''}
              onChange={e => onFilterChange?.('fuzzySearch', e.target.value || undefined)}
              className="pl-10"
            />
          </div>

          {/* Filter toggle button and clear all */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFiltersExpanded(!filtersExpanded)}
              className="flex items-center gap-2"
            >
              <Filter className="h-4 w-4" />
              Filters
              <ChevronDown
                className={`h-4 w-4 transition-transform ${filtersExpanded ? 'rotate-180' : ''}`}
              />
              {hasActiveFilters && <div className="bg-primary ml-1 h-2 w-2 rounded-full" />}
            </Button>
            {hasActiveFilters && (
              <Button variant="outline" size="sm" onClick={onClearFilters}>
                <X className="mr-2 h-4 w-4" />
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {/* Expandable filters section */}
        {filtersExpanded && (
          <div className="border-t pt-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* Action Filter */}
              <div className="space-y-2">
                <Label>Actions</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between">
                      {filters?.action && filters.action.length > 0
                        ? filters.action
                            .map(action =>
                              action
                                .replace('organization.', '')
                                .replace(/\./g, ' ')
                                .replace(/_/g, ' ')
                            )
                            .join(', ')
                        : 'All actions'}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56" align="start">
                    <DropdownMenuLabel>Select Actions</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={!filters?.action || filters.action.length === 0}
                      onCheckedChange={checked => {
                        if (checked) {
                          onFilterChange?.('action', undefined);
                        }
                      }}
                    >
                      All actions
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    {(
                      availableActions || [
                        'organization.user.login',
                        'organization.user.logout',
                        'organization.user.accept_invite',
                        'organization.user.send_invite',
                        'organization.user.revoke_invite',
                        'organization.settings.change',
                        'organization.purchase_credits',
                        'organization.member.remove',
                        'organization.member.change_role',
                        'organization.sso.set_domain',
                        'organization.sso.remove_domain',
                      ]
                    ).map(action => (
                      <DropdownMenuCheckboxItem
                        key={action}
                        checked={filters?.action?.includes(action) || false}
                        onCheckedChange={checked => {
                          const currentActions = filters?.action || [];
                          if (checked) {
                            // Add action to the list
                            const newActions = [...currentActions, action];
                            onFilterChange?.('action', newActions);
                          } else {
                            // Remove action from the list
                            const newActions = currentActions.filter(a => a !== action);
                            onFilterChange?.(
                              'action',
                              newActions.length > 0 ? newActions : undefined
                            );
                          }
                        }}
                      >
                        {action.replace('organization.', '').replace(/\./g, ' ').replace(/_/g, ' ')}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Actor Email Filter */}
              <div className="space-y-2">
                <Label htmlFor="actor-email-filter">Actor Email</Label>
                <Input
                  id="actor-email-filter"
                  type="email"
                  placeholder="user@example.com"
                  value={filters?.actorEmail || ''}
                  onChange={e => onFilterChange?.('actorEmail', e.target.value || undefined)}
                />
              </div>

              {/* Start Time Filter */}
              <div className="space-y-2">
                <Label htmlFor="start-time-filter">Start Date & Time</Label>
                <div className="flex gap-2">
                  <Input
                    id="start-time-filter"
                    type="date"
                    value={filters?.startTime ? filters.startTime.toISOString().split('T')[0] : ''}
                    max={filters?.endTime ? filters.endTime.toISOString().split('T')[0] : undefined}
                    onChange={e => {
                      const dateValue = e.target.value;
                      if (!dateValue) {
                        onFilterChange?.('startTime', undefined);
                        return;
                      }

                      // Validate that start date is not after end date
                      if (filters?.endTime) {
                        const selectedDate = new Date(dateValue);
                        const endDate = new Date(filters.endTime.toISOString().split('T')[0]);
                        if (selectedDate > endDate) {
                          return; // Don't update if invalid
                        }
                      }

                      const currentTime = filters?.startTime
                        ? filters.startTime.toISOString().split('T')[1]
                        : '00:00:00.000Z';
                      const newDateTime = new Date(`${dateValue}T${currentTime}`);
                      onFilterChange?.('startTime', newDateTime);
                    }}
                    className="w-36 [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:invert-[0.5]"
                  />
                  <Input
                    type="time"
                    value={
                      filters?.startTime
                        ? filters.startTime.toISOString().split('T')[1].substring(0, 5)
                        : ''
                    }
                    onChange={e => {
                      const timeValue = e.target.value;
                      if (!filters?.startTime && !timeValue) return;

                      const currentDate = filters?.startTime
                        ? filters.startTime.toISOString().split('T')[0]
                        : new Date().toISOString().split('T')[0];
                      const newDateTime = new Date(`${currentDate}T${timeValue}:00.000Z`);
                      onFilterChange?.('startTime', newDateTime);
                    }}
                    className="w-28 [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:invert-[0.5]"
                  />
                </div>
              </div>

              {/* End Time Filter */}
              <div className="space-y-2">
                <Label htmlFor="end-time-filter">End Date & Time</Label>
                <div className="flex gap-2">
                  <Input
                    id="end-time-filter"
                    type="date"
                    value={filters?.endTime ? filters.endTime.toISOString().split('T')[0] : ''}
                    min={
                      filters?.startTime ? filters.startTime.toISOString().split('T')[0] : undefined
                    }
                    onChange={e => {
                      const dateValue = e.target.value;
                      if (!dateValue) {
                        onFilterChange?.('endTime', undefined);
                        return;
                      }

                      // Validate that end date is not before start date
                      if (filters?.startTime) {
                        const selectedDate = new Date(dateValue);
                        const startDate = new Date(filters.startTime.toISOString().split('T')[0]);
                        if (selectedDate < startDate) {
                          return; // Don't update if invalid
                        }
                      }

                      const currentTime = filters?.endTime
                        ? filters.endTime.toISOString().split('T')[1]
                        : '23:59:59.999Z';
                      const newDateTime = new Date(`${dateValue}T${currentTime}`);
                      onFilterChange?.('endTime', newDateTime);
                    }}
                    className="w-36 [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:invert-[0.5]"
                  />
                  <Input
                    type="time"
                    value={
                      filters?.endTime
                        ? filters.endTime.toISOString().split('T')[1].substring(0, 5)
                        : ''
                    }
                    onChange={e => {
                      const timeValue = e.target.value;
                      if (!filters?.endTime && !timeValue) return;

                      const currentDate = filters?.endTime
                        ? filters.endTime.toISOString().split('T')[0]
                        : new Date().toISOString().split('T')[0];
                      const newDateTime = new Date(`${currentDate}T${timeValue}:00.000Z`);
                      onFilterChange?.('endTime', newDateTime);
                    }}
                    className="w-28 [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:invert-[0.5]"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
