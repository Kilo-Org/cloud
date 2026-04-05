'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelCard } from './ModelCard';
import { motion, AnimatePresence } from 'motion/react';
import type { OpenRouterProvider } from './util';
import { Checkbox } from '@/components/ui/checkbox';

interface ProviderCardProps {
  provider: OpenRouterProvider;
  isExpanded: boolean;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  onToggleExpansion: () => void;
  onToggleProvider: () => void;
  onToggleModel: (modelSlug: string) => void;
  isModelSelected: (modelSlug: string) => boolean;
  readonly?: boolean;
  allowAllModels?: boolean;
  onToggleAllowAllModels?: () => void;
}

export function ProviderCard({
  provider,
  isExpanded,
  isFullySelected,
  isPartiallySelected,
  onToggleExpansion,
  onToggleProvider,
  onToggleModel,
  isModelSelected,
  readonly = false,
  allowAllModels = false,
  onToggleAllowAllModels,
}: ProviderCardProps) {
  const handleProviderClick = (e: React.MouseEvent) => {
    // Don't toggle expansion if clicking on the checkbox
    if ((e.target as HTMLElement).closest('[data-provider-checkbox]')) {
      return;
    }
    onToggleExpansion();
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Provider Header */}
        <div
          className="hover:bg-muted/50 flex cursor-pointer items-center justify-between p-4"
          onClick={handleProviderClick}
        >
          <div className="flex items-center gap-3">
            <div data-provider-checkbox className="leading-0" onClick={e => e.stopPropagation()}>
              <Checkbox
                checked={isFullySelected}
                ref={el => {
                  if (el && isPartiallySelected && !isFullySelected) {
                    el.indeterminate = true;
                  }
                }}
                onCheckedChange={readonly ? undefined : onToggleProvider}
                disabled={readonly}
              />
            </div>
            <div className="flex items-center gap-2">
              {provider.icon && (
                <img
                  src={
                    provider.icon.url.startsWith('http')
                      ? provider.icon.url
                      : `https://openrouter.ai${provider.icon.url}`
                  }
                  alt={provider.displayName}
                  className={cn('h-5 w-5', provider.icon.className)}
                />
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{provider.displayName}</h3>
                  {/* Data Policy Badges */}
                  <div className="flex gap-1">
                    {provider.dataPolicy.training && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="h-5 border-red-500/30 bg-red-500/10 px-1.5 text-[10px] text-red-400"
                          >
                            Trains
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Uses data for training AI models</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {provider.dataPolicy.retainsPrompts && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="h-5 border-orange-500/30 bg-orange-500/10 px-1.5 text-[10px] text-orange-400"
                          >
                            Retains prompt
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Retains user prompts</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {provider.dataPolicy.canPublish && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="h-5 border-yellow-500/30 bg-yellow-500/10 px-1.5 text-[10px] text-yellow-400"
                          >
                            Publishes
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Can publish user content</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
                <p className="text-muted-foreground text-sm">
                  {provider.models.length} model{provider.models.length !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {provider.models.filter(m => isModelSelected(m.slug)).length} selected
            </Badge>
            <motion.div
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
            >
              <ChevronRight className="h-4 w-4" />
            </motion.div>
          </div>
        </div>

        {/* Models List */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="bg-muted/25 border-t p-4">
                <div className="space-y-3">
                  {/* Allow All Models Row */}
                  <div className="bg-muted/50 flex items-start gap-3 rounded-md border p-4">
                    <div className="flex flex-1 gap-3">
                      <Checkbox
                        id={`allow-all-models-${provider.slug}`}
                        checked={allowAllModels}
                        onCheckedChange={
                          readonly
                            ? undefined
                            : () => {
                                onToggleAllowAllModels?.();
                              }
                        }
                        disabled={readonly}
                        className="mt-1"
                      />
                      <div className="flex-1 flex-col">
                        <label
                          htmlFor={`allow-all-models-${provider.slug}`}
                          className="cursor-pointer text-sm font-medium"
                        >
                          Allow all {provider.displayName} models
                        </label>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {allowAllModels
                            ? 'All current and future models from this provider will be allowed'
                            : 'Check this box to automatically allow all models from this provider, including future model releases'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Models List */}
                  {provider.models.map(model => (
                    <div key={`${provider.slug}-${model.slug}`}>
                      <ModelCard
                        model={model}
                        isSelected={allowAllModels || isModelSelected(model.slug)}
                        onToggle={() => onToggleModel(model.slug)}
                        readonly={readonly || allowAllModels}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
