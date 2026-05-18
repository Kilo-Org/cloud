'use client';
import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown } from 'lucide-react';

export type SortDirection = 'asc' | 'desc';

export type UsageTableColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right';
  render?: (value: unknown, row: UsageTableRow) => React.ReactNode;
  /** When false on a sortable table, this column cannot be sorted. */
  sortable?: boolean;
  /** Custom accessor used when sorting; defaults to row[column.key]. */
  sortAccessor?: (row: UsageTableRow) => string | number | null | undefined;
};

export type UsageTableRow = {
  [key: string]: unknown;
  expandable?: boolean;
  expandedContent?: UsageTableRow[];
};

type UsageTableBaseProps = {
  title: string;
  columns: UsageTableColumn[];
  data: UsageTableRow[];
  emptyMessage?: string;
  headerContent?: React.ReactNode;
  headerActions?: React.ReactNode;
  /** When true, column headers become clickable to toggle sort. */
  sortable?: boolean;
  /** Initial sort state when sortable is true. */
  defaultSort?: { key: string; direction: SortDirection };
};

export function UsageTableBase({
  title,
  columns,
  data,
  emptyMessage = 'No data available',
  headerContent,
  headerActions,
  sortable = false,
  defaultSort,
}: UsageTableBaseProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(
    defaultSort ?? null
  );

  const toggleRowExpansion = (rowKey: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(rowKey)) {
      newExpanded.delete(rowKey);
    } else {
      newExpanded.add(rowKey);
    }
    setExpandedRows(newExpanded);
  };

  const getRowKey = (row: UsageTableRow, index: number) => {
    return (row.id as string) || (row.date as string) || `row-${index}`;
  };

  const columnByKey = useMemo(() => {
    const m = new Map<string, UsageTableColumn>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);

  const toggleSort = (key: string): void => {
    if (!sortable) return;
    const col = columnByKey.get(key);
    if (col && col.sortable === false) return;
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, direction: 'desc' };
      if (prev.direction === 'desc') return { key, direction: 'asc' };
      return null;
    });
  };

  const sortedData = useMemo(() => {
    if (!sortable || !sort) return data;
    const col = columnByKey.get(sort.key);
    if (!col) return data;
    const accessor = col.sortAccessor ?? ((row: UsageTableRow) => row[sort.key] as unknown);
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data, sortable, sort, columnByKey]);

  const renderSortIcon = (columnKey: string, columnSortable: boolean) => {
    if (!sortable || !columnSortable) return null;
    if (sort?.key !== columnKey) {
      return <ChevronsUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    }
    return sort.direction === 'asc' ? (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    );
  };

  return (
    <Card>
      <CardHeader>
        {headerContent}
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">{title}</CardTitle>
          {headerActions}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="overflow-x-auto rounded-b-lg">
          <table className="w-full">
            <thead>
              <tr className="bg-background border-muted border-b">
                {sortedData.some(row => row.expandable) && (
                  <th className="text-muted-foreground w-12 px-6 py-3 text-left text-xs font-medium tracking-wider uppercase"></th>
                )}
                {columns.map(column => {
                  const columnSortable = sortable && column.sortable !== false;
                  return (
                    <th
                      key={column.key}
                      className={cn(
                        'text-muted-foreground px-6 py-3 text-xs font-medium tracking-wider uppercase',
                        column.align === 'right' ? 'text-right' : 'text-left',
                        columnSortable && 'hover:text-foreground cursor-pointer select-none'
                      )}
                      onClick={columnSortable ? () => toggleSort(column.key) : undefined}
                    >
                      {column.label}
                      {renderSortIcon(column.key, columnSortable)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-muted divide-y rounded-b-lg">
              {sortedData.map((row, index) => {
                const rowKey = getRowKey(row, index);
                const isLastRow = index === sortedData.length - 1;
                const isExpanded = expandedRows.has(rowKey);

                return (
                  <React.Fragment key={rowKey}>
                    <tr
                      key={rowKey}
                      className={`hover:bg-background ${isLastRow && !isExpanded ? 'rounded-b-lg' : ''} ${
                        row.expandable ? 'cursor-pointer' : ''
                      }`}
                      onClick={row.expandable ? () => toggleRowExpansion(rowKey) : undefined}
                    >
                      {sortedData.some(r => r.expandable) && (
                        <td className="px-6 py-4">
                          {row.expandable && (
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </td>
                      )}
                      {columns.map((column, colIndex) => {
                        const isFirstCol = colIndex === 0;
                        const isLastCol = colIndex === columns.length - 1;
                        const cellValue = row[column.key];
                        const renderedValue = column.render
                          ? column.render(cellValue, row)
                          : (cellValue as React.ReactNode);

                        return (
                          <td
                            key={column.key}
                            className={`text-muted-foreground px-6 py-4 text-sm whitespace-nowrap ${
                              column.align === 'right' ? 'text-right' : 'text-left'
                            } ${
                              isLastRow && !isExpanded
                                ? isFirstCol && !sortedData.some(r => r.expandable)
                                  ? 'rounded-bl-lg'
                                  : isLastCol
                                    ? 'rounded-br-lg'
                                    : ''
                                : ''
                            }`}
                          >
                            {renderedValue}
                          </td>
                        );
                      })}
                    </tr>
                    {row.expandable && isExpanded && row.expandedContent && (
                      <>
                        {row.expandedContent.map((expandedRow, expandedIndex) => {
                          const expandedRowKey = `${rowKey}-expanded-${expandedIndex}`;
                          const isLastExpandedRow =
                            expandedIndex === (row.expandedContent?.length || 0) - 1;
                          const isLastMainRow = index === sortedData.length - 1;

                          return (
                            <tr
                              key={expandedRowKey}
                              className={`bg-background/50 ${
                                isLastExpandedRow && isLastMainRow ? 'rounded-b-lg' : ''
                              }`}
                            >
                              {sortedData.some(r => r.expandable) && <td></td>}
                              {columns.map((column, colIndex) => {
                                const isFirstCol = colIndex === 0;
                                const isLastCol = colIndex === columns.length - 1;
                                const cellValue = expandedRow[column.key];
                                const renderedValue = column.render
                                  ? column.render(cellValue, expandedRow)
                                  : (cellValue as React.ReactNode);

                                return (
                                  <td
                                    key={column.key}
                                    className={`text-muted-foreground px-6 py-4 text-sm whitespace-nowrap ${
                                      column.align === 'right' ? 'text-right' : 'text-left'
                                    } ${isFirstCol ? 'pl-14' : ''} ${
                                      isLastExpandedRow && isLastMainRow
                                        ? isFirstCol && !sortedData.some(r => r.expandable)
                                          ? 'rounded-bl-lg'
                                          : isLastCol
                                            ? 'rounded-br-lg'
                                            : ''
                                        : ''
                                    }`}
                                  >
                                    {renderedValue}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {sortedData.length === 0 && (
          <div className="text-muted-foreground px-6 py-12 text-center">{emptyMessage}</div>
        )}
      </CardContent>
    </Card>
  );
}
