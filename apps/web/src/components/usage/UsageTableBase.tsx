'use client';
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';

export type UsageTableColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right';
  render?: (value: unknown, row: UsageTableRow) => React.ReactNode;
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
};

export function UsageTableBase({
  title,
  columns,
  data,
  emptyMessage = 'No data available',
  headerContent,
  headerActions,
}: UsageTableBaseProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
                {data.some(row => row.expandable) && (
                  <th className="text-muted-foreground w-12 px-6 py-3 text-left text-xs font-medium tracking-wider uppercase"></th>
                )}
                {columns.map(column => (
                  <th
                    key={column.key}
                    className={`text-muted-foreground px-6 py-3 text-xs font-medium tracking-wider uppercase ${
                      column.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-muted divide-y rounded-b-lg">
              {data.map((row, index) => {
                const rowKey = getRowKey(row, index);
                const isLastRow = index === data.length - 1;
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
                      {data.some(r => r.expandable) && (
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
                                ? isFirstCol && !data.some(r => r.expandable)
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
                          const isLastMainRow = index === data.length - 1;

                          return (
                            <tr
                              key={expandedRowKey}
                              className={`bg-background/50 ${
                                isLastExpandedRow && isLastMainRow ? 'rounded-b-lg' : ''
                              }`}
                            >
                              {data.some(r => r.expandable) && <td></td>}
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
                                        ? isFirstCol && !data.some(r => r.expandable)
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

        {data.length === 0 && (
          <div className="text-muted-foreground px-6 py-12 text-center">{emptyMessage}</div>
        )}
      </CardContent>
    </Card>
  );
}
