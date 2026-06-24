'use client';

import * as React from 'react';

import {
  tableBodyClassName,
  tableCaptionClassName,
  tableCellClassName,
  tableClassName,
  tableFooterClassName,
  tableHeadClassName,
  tableHeaderClassName,
  tableRowClassName,
} from '@/components/ui/primitive-classnames';
import { cn } from '@/lib/utils';

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

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
