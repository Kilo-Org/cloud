import * as React from 'react';

import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const textareaClassName =
  'border-input bg-input-background type-body placeholder:text-muted-foreground flex min-h-20 w-full rounded-md border px-3 py-2 transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/40 aria-invalid:border-destructive';

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return <textarea className={cn(textareaClassName, className)} ref={ref} {...props} />;
  }
);
Textarea.displayName = 'Textarea';

export { textareaClassName };
