import * as React from 'react';

import { textareaClassName } from '@/components/ui/primitive-classnames';
import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return <textarea className={cn(textareaClassName, className)} ref={ref} {...props} />;
  }
);
Textarea.displayName = 'Textarea';
