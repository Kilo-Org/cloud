'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

const tableClassName = 'type-body w-full caption-bottom';
const tableHeaderClassName = 'border-b border-border';
const tableBodyClassName = '[&_tr:last-child]:border-0';
const tableFooterClassName = 'bg-surface-raised border-t border-border font-medium';
const tableRowClassName =
  'h-12 border-b border-border transition-colors hover:bg-surface-hover data-[state=selected]:bg-surface-selected';
const tableHeadClassName =
  'type-label text-muted-foreground h-12 px-3 text-left align-middle whitespace-nowrap';
const tableCellClassName = 'px-3 py-3 align-middle';
const tableCaptionClassName = 'type-body text-muted-foreground mt-4';

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return <table className={cn(tableClassName, className)} {...props} />;
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn(tableHeaderClassName, className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn(tableBodyClassName, className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return <tfoot className={cn(tableFooterClassName, className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn(tableRowClassName, className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn(tableHeadClassName, className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn(tableCellClassName, className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption className={cn(tableCaptionClassName, className)} {...props} />;
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  tableClassName,
  tableHeaderClassName,
  tableBodyClassName,
  tableFooterClassName,
  tableRowClassName,
  tableHeadClassName,
  tableCellClassName,
  tableCaptionClassName,
};
