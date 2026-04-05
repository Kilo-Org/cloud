'use client';

import { useState } from 'react';
import type { OpenRouterModel } from '@/lib/providers/openrouter/openrouter-types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatPrice, formatContextLength } from './util';

interface ModelCardProps {
  model: OpenRouterModel;
  isSelected: boolean;
  onToggle: () => void;
  readonly?: boolean;
}

export function ModelCard({ model, isSelected, onToggle, readonly = false }: ModelCardProps) {
  const [showDescription, setShowDescription] = useState(false);
  const endpoint = model.endpoint;
  const promptPrice = endpoint?.pricing?.prompt || '0';
  const completionPrice = endpoint?.pricing?.completion || '0';

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't toggle selection if clicking on the model name (description toggle) or checkbox
    if (
      (e.target as HTMLElement).closest('[data-description-toggle]') ||
      (e.target as HTMLElement).closest('[data-model-checkbox]')
    ) {
      return;
    }
    onToggle();
  };

  const handleNameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDescription(!showDescription);
  };

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:shadow-md',
        isSelected && 'ring-primary/50 bg-primary/2 ring-1'
      )}
      onClick={handleCardClick}
    >
      <CardContent className="p-4">
        <div className="mb-2 flex items-start justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div data-model-checkbox onClick={e => e.stopPropagation()} className="mt-0.5">
              <Checkbox
                checked={isSelected}
                onCheckedChange={readonly ? undefined : onToggle}
                disabled={readonly}
              />
            </div>
            <div className="min-w-0 flex-1">
              <button
                data-description-toggle
                onClick={handleNameClick}
                className="hover:text-primary flex items-center gap-1 text-left transition-colors"
              >
                {showDescription ? (
                  <ChevronDown className="h-3 w-3 flex-shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                )}
                <h3 className="truncate text-sm font-semibold">{model.name}</h3>
              </button>
              <p className="text-muted-foreground mt-1 ml-4 text-xs">{model.author}</p>
            </div>
          </div>
          <div className="ml-2 flex flex-col items-end gap-1">
            <Badge variant="outline" className="text-xs">
              Context: {formatContextLength(model.context_length)}
            </Badge>
            {endpoint?.is_free && (
              <Badge variant="secondary" className="text-xs">
                Free
              </Badge>
            )}
          </div>
        </div>

        {/* Description section */}
        {showDescription && (
          <div className="mb-3 ml-10">
            <p className="text-muted-foreground text-xs">{model.description}</p>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {model.input_modalities?.map(modality => (
              <Badge key={modality} variant="outline" className="text-xs">
                {modality}
              </Badge>
            ))}
            {model.output_modalities?.map(modality => (
              <Badge key={modality} variant="secondary" className="text-xs">
                {modality} out
              </Badge>
            ))}
          </div>

          {endpoint && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{endpoint.provider_display_name}</span>
              <div className="flex gap-2">
                <span>In: {formatPrice(promptPrice)}</span>
                <span>Out: {formatPrice(completionPrice)}</span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
