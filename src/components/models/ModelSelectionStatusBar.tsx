'use client';

import { Button } from '@/components/ui/button';
import { Save, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModelSelectionStatusBarProps {
  isVisible: boolean;
  selectedProvidersCount: number;
  selectedModelsCount: number;
  onSave: () => void;
  onCancel: () => void;
}

export function ModelSelectionStatusBar({
  isVisible,
  selectedProvidersCount,
  selectedModelsCount,
  onSave,
  onCancel,
}: ModelSelectionStatusBarProps) {
  return (
    <div
      className={cn(
        'bg-accent/95 fixed bottom-6 left-1/2 z-50 mx-6 w-full max-w-6xl -translate-x-1/2 rounded-lg border shadow-2xl backdrop-blur-sm transition-all duration-300 ease-in-out',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
      )}
    >
      <div className="px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <span className="text-foreground font-medium">
              {selectedProvidersCount} {selectedProvidersCount === 1 ? 'Provider' : 'Providers'} and{' '}
              {selectedModelsCount} {selectedModelsCount === 1 ? 'model' : 'models'} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              onClick={onCancel}
              size="sm"
              className="flex items-center gap-2"
            >
              <X className="h-4 w-4" />
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              size="sm"
              className="flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
