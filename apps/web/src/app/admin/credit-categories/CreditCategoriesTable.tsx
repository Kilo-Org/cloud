'use client';

import { useCallback, useState, useMemo } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { FileText, User } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { UserSearchInput } from '../components/UserSearchInput';
import type {
  CreditCategoriesApiResponse,
  GuiCreditCategoryStatistics,
} from '@/lib/PromoCreditCategoryConfig';
import type { CreditCategorySortableField, CreditCategorySortConfig } from '@/types/admin';
import { CreditCategoriesTableHeader } from './CreditCategoriesTableHeader';

export function CreditCategoriesTable() {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [hideUnavailable, setHideUnavailable] = useState(true);
  const [hideObsolete, setHideObsolete] = useState(true);
  const [hideZeroRedemptions, setHideZeroRedemptions] = useState(false);
  const [sortConfig, setSortConfig] = useState<CreditCategorySortConfig | null>({
    field: 'is_user_selfservicable',
    direction: 'desc',
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-credit-categories'],
    queryFn: async () => {
      const response = await fetch('/admin/api/credit-categories');

      if (!response.ok) {
        throw new Error('Failed to fetch credit categories');
      }

      return (await response.json()) as CreditCategoriesApiResponse;
    },
  });

  // Sort function for credit categories
  const sortCreditCategories = useCallback(
    (
      categories: GuiCreditCategoryStatistics[],
      sortConfig: CreditCategorySortConfig | null
    ): GuiCreditCategoryStatistics[] => {
      if (!sortConfig) return categories;

      return [...categories].sort((a, b) => {
        const aValue = a[sortConfig.field];
        const bValue = b[sortConfig.field];

        const directionSign = sortConfig.direction === 'asc' ? 1 : -1;
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          return aValue.localeCompare(bValue) * directionSign;
        }

        if (aValue == null || bValue == null)
          return bValue != null ? -directionSign : aValue != null ? directionSign : 0;

        return aValue < bValue ? -directionSign : aValue > bValue ? directionSign : 0;
      });
    },
    []
  );

  // Filter and sort data client-side
  const filteredAndSortedData = useMemo(() => {
    if (!data) return data;

    // First filter by search term
    let filteredCategories = data.creditCategories;
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      filteredCategories = data.creditCategories.filter(
        category =>
          category.credit_category.toLowerCase().includes(searchLower) ||
          category.description?.toLowerCase().includes(searchLower) ||
          category.adminUI_label?.toLowerCase().includes(searchLower)
      );
    }

    // Filter by availability
    if (hideUnavailable) {
      filteredCategories = filteredCategories.filter(category => {
        const hasEnded =
          category.promotion_ends_at && new Date(category.promotion_ends_at) < new Date();
        const hasReachedLimit =
          category.total_redemptions_allowed &&
          category.credit_count >= category.total_redemptions_allowed;
        return !hasEnded && !hasReachedLimit;
      });
    }

    // Filter by obsolete status
    if (hideObsolete) {
      filteredCategories = filteredCategories.filter(category => !category.obsolete);
    }

    // Filter by zero redemptions
    if (hideZeroRedemptions) {
      filteredCategories = filteredCategories.filter(category => category.credit_count > 0);
    }

    // Then sort the filtered results
    const sortedCategories = sortCreditCategories(filteredCategories, sortConfig);

    return {
      ...data,
      creditCategories: sortedCategories,
    };
  }, [
    data,
    searchTerm,
    hideUnavailable,
    hideObsolete,
    hideZeroRedemptions,
    sortConfig,
    sortCreditCategories,
  ]);

  // Handle row click
  const handleRowClick = (idempotencyKey: string) => {
    router.push(`/admin/credit-categories/${encodeURIComponent(idempotencyKey)}`);
  };

  // Handle search
  const handleSearchChange = useCallback((newSearchTerm: string) => {
    setSearchTerm(newSearchTerm);
  }, []);

  // Handle sorting
  const handleSort = useCallback((field: CreditCategorySortableField) => {
    setSortConfig(prevConfig => {
      if (!prevConfig || prevConfig.field !== field) {
        return { field, direction: 'desc' };
      }
      if (prevConfig.direction === 'desc') {
        return { field, direction: 'asc' };
      }
      return null; // Remove sorting
    });
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex max-w-max flex-col gap-y-4">
      {/* Header Section */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Credit Categories</h2>
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/admin/credit-categories/docs')}
            className="flex items-center gap-2"
          >
            <FileText className="h-4 w-4" />
            Documentation
          </Button>
          <div className="flex items-center gap-4">
            <div className="flex items-center space-x-2">
              <Switch
                id="hide-unavailable"
                checked={hideUnavailable}
                onCheckedChange={setHideUnavailable}
              />
              <Label htmlFor="hide-unavailable" className="cursor-pointer text-sm font-normal">
                Hide unavailable
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Switch id="hide-obsolete" checked={hideObsolete} onCheckedChange={setHideObsolete} />
              <Label htmlFor="hide-obsolete" className="cursor-pointer text-sm font-normal">
                Hide obsolete
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="hide-zero-redemptions"
                checked={hideZeroRedemptions}
                onCheckedChange={setHideZeroRedemptions}
              />
              <Label htmlFor="hide-zero-redemptions" className="cursor-pointer text-sm font-normal">
                Hide unused
              </Label>
            </div>
          </div>
          <div className="w-80">
            <UserSearchInput
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Search credit categories..."
            />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <CreditCategoriesTableHeader sortConfig={sortConfig} onSort={handleSort} />
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <div className="bg-muted h-4 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="bg-muted mx-auto h-4 w-4 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-muted ml-auto h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            ) : filteredAndSortedData?.creditCategories.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-8 text-center">
                  <div className="text-muted-foreground">
                    {searchTerm.trim()
                      ? 'No credit categories found matching your search.'
                      : 'No credit categories available.'}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredAndSortedData?.creditCategories.map(creditCategory => {
                const tooltipContent = creditCategory.adminUI_label || creditCategory.description;

                // Check if category has ended
                const hasEnded =
                  creditCategory.promotion_ends_at &&
                  new Date(creditCategory.promotion_ends_at) < new Date();

                // Check if category has reached redemption limit
                const hasReachedLimit =
                  creditCategory.total_redemptions_allowed &&
                  creditCategory.credit_count >= creditCategory.total_redemptions_allowed;

                // Determine if category should be grayed out
                const isUnavailable = hasEnded || hasReachedLimit;
                const isObsolete = creditCategory.obsolete;

                const creditCategoryCell = (
                  <code
                    className={`rounded px-2 py-1 text-xs ${
                      isUnavailable ? 'bg-muted/50 text-muted-foreground' : 'bg-muted'
                    } ${isObsolete ? 'line-through' : ''}`}
                  >
                    {creditCategory.credit_category}
                  </code>
                );

                return (
                  <TableRow
                    key={creditCategory.credit_category}
                    className={`cursor-pointer transition-colors ${
                      isUnavailable || isObsolete
                        ? 'hover:bg-muted/30 opacity-60'
                        : 'hover:bg-muted/50'
                    }`}
                    onClick={() => handleRowClick(creditCategory.credit_category)}
                  >
                    <TableCell className="font-medium">
                      {tooltipContent ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>{creditCategoryCell}</TooltipTrigger>
                            <TooltipContent>
                              <p>{tooltipContent}</p>
                              {(isUnavailable || isObsolete) && (
                                <p className="text-muted-foreground mt-1 text-xs">
                                  {isObsolete && 'Obsolete'}
                                  {isObsolete && (hasEnded || hasReachedLimit) && ' • '}
                                  {hasEnded && 'Promotion has ended'}
                                  {hasEnded && hasReachedLimit && ' • '}
                                  {hasReachedLimit && 'Redemption limit reached'}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        creditCategoryCell
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {creditCategory.is_user_selfservicable && (
                        <User
                          className={`mx-auto h-4 w-4 ${
                            isUnavailable || isObsolete ? 'text-blue-600/50' : 'text-blue-600'
                          }`}
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.promotion_ends_at ? (
                        <span
                          title={format(new Date(creditCategory.promotion_ends_at), 'PPpp')}
                          className={`cursor-help ${hasEnded ? 'text-destructive/70' : ''}`}
                        >
                          {formatDistanceToNow(new Date(creditCategory.promotion_ends_at), {
                            addSuffix: true,
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.user_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.blocked_user_count > 0 ? (
                        <span className="text-destructive">
                          {creditCategory.blocked_user_count.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={hasReachedLimit ? 'text-destructive/70' : ''}>
                        {creditCategory.credit_count.toLocaleString()}
                        {creditCategory.total_redemptions_allowed && (
                          <span className="text-muted-foreground">
                            {' / '}
                            {creditCategory.total_redemptions_allowed.toLocaleString()}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      ${creditCategory.total_dollars.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.user_count_last_week.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.credit_count_last_week.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      ${creditCategory.total_dollars_last_week.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.first_used_at ? (
                        <span
                          title={format(new Date(creditCategory.first_used_at), 'PPpp')}
                          className="cursor-help"
                        >
                          {formatDistanceToNow(new Date(creditCategory.first_used_at), {
                            addSuffix: true,
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {creditCategory.last_used_at ? (
                        <span
                          title={format(new Date(creditCategory.last_used_at), 'PPpp')}
                          className="cursor-help"
                        >
                          {formatDistanceToNow(new Date(creditCategory.last_used_at), {
                            addSuffix: true,
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
