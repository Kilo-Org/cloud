'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';

type InlineDeleteConfirmationProps = {
  onDelete: () => Promise<void> | void;
  isLoading?: boolean;
  disabled?: boolean;
  confirmText?: string;
  cancelText?: string;
  warningText?: string;
  className?: string;
  showAsButton?: boolean;
  buttonText?: string;
};

export function InlineDeleteConfirmation({
  onDelete,
  isLoading = false,
  disabled = false,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  warningText,
  className = '',
  showAsButton = false,
  buttonText = 'Delete',
}: InlineDeleteConfirmationProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDelete = async () => {
    try {
      await onDelete();
      setShowConfirm(false);
    } catch (_error) {
      // Error handling is expected to be done by the parent component
      setShowConfirm(false);
    }
  };

  if (showConfirm) {
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        {warningText && <p className="text-destructive max-w-48 text-xs">{warningText}</p>}
        <div className="flex items-center gap-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={isLoading || disabled}
            className="h-8 px-2 text-xs"
          >
            {isLoading ? (
              <div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
            ) : (
              confirmText
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowConfirm(false)}
            disabled={isLoading}
            className="h-8 px-2 text-xs"
          >
            {cancelText}
          </Button>
        </div>
      </div>
    );
  }

  if (showAsButton) {
    return (
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setShowConfirm(true)}
        disabled={isLoading || disabled}
        className={className}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {buttonText}
      </Button>
    );
  }

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={() => setShowConfirm(true)}
      disabled={isLoading || disabled}
      className={`h-8 w-8 p-0 ${className}`}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}
