'use client';

import { useState } from 'react';
import {
  APP_BUILDER_GALLERY_TEMPLATES,
  APP_BUILDER_GALLERY_TEMPLATE_METADATA,
  getTemplatePreviewUrl,
  type AppBuilderGalleryTemplate,
} from '@/lib/app-builder/constants';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileUser, Rocket, ExternalLink, Loader2, Sparkles } from 'lucide-react';

const TEMPLATE_ICONS: Record<
  AppBuilderGalleryTemplate,
  React.ComponentType<{ className?: string }>
> = {
  resume: FileUser,
  'startup-landing-page': Rocket,
};

type TemplateGalleryProps = {
  onSelectTemplate: (template: AppBuilderGalleryTemplate) => void;
  isCreating: boolean;
  disabled?: boolean;
};

export function TemplateGallery({ onSelectTemplate, isCreating, disabled }: TemplateGalleryProps) {
  const [previewTemplate, setPreviewTemplate] = useState<AppBuilderGalleryTemplate | null>(null);
  const [isIframeLoading, setIsIframeLoading] = useState(true);

  const handleCardClick = (templateId: AppBuilderGalleryTemplate) => {
    setPreviewTemplate(templateId);
    setIsIframeLoading(true);
  };

  const handleUseTemplate = () => {
    if (previewTemplate) {
      onSelectTemplate(previewTemplate);
    }
  };

  const handleCloseDialog = () => {
    if (!isCreating) {
      setPreviewTemplate(null);
    }
  };

  const previewMeta = previewTemplate
    ? APP_BUILDER_GALLERY_TEMPLATE_METADATA[previewTemplate]
    : null;
  const previewUrl = previewTemplate ? getTemplatePreviewUrl(previewTemplate) : null;

  return (
    <>
      <div className="mt-8">
        <h3 className="text-muted-foreground mb-3 text-sm font-medium">Or start from a template</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {APP_BUILDER_GALLERY_TEMPLATES.map(templateId => {
            const meta = APP_BUILDER_GALLERY_TEMPLATE_METADATA[templateId];
            const Icon = TEMPLATE_ICONS[templateId];

            return (
              <Card
                key={templateId}
                className={cn(
                  'hover:border-primary/50 hover:bg-accent/50 cursor-pointer transition-all',
                  disabled && 'pointer-events-none opacity-50'
                )}
                onClick={() => !disabled && handleCardClick(templateId)}
              >
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="bg-primary/10 rounded-lg p-2">
                    <Icon className="text-primary h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{meta.name}</div>
                    <div className="text-muted-foreground truncate text-sm">
                      {meta.shortDescription}
                    </div>
                  </div>
                  <ExternalLink className="text-muted-foreground h-4 w-4 shrink-0" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Template Preview Dialog */}
      <Dialog open={!!previewTemplate} onOpenChange={open => !open && handleCloseDialog()}>
        <DialogContent className="flex h-[90vh] max-h-[800px] max-w-4xl flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">{previewMeta?.name}</DialogTitle>
            <DialogDescription>{previewMeta?.longDescription}</DialogDescription>
          </DialogHeader>

          {/* Preview iframe */}
          <div className="bg-muted relative min-h-0 flex-1 overflow-hidden rounded-lg border">
            {isIframeLoading && (
              <div className="bg-background/80 absolute inset-0 flex items-center justify-center">
                <Loader2 className="text-primary h-8 w-8 animate-spin" />
              </div>
            )}
            {previewUrl && (
              <iframe
                src={previewUrl}
                className="h-full w-full border-0"
                title={`Preview of ${previewMeta?.name}`}
                onLoad={() => setIsIframeLoading(false)}
              />
            )}
          </div>

          <DialogFooter className="flex-row gap-2 sm:justify-between">
            <Button variant="outline" onClick={handleCloseDialog} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={handleUseTemplate} disabled={isCreating}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Use This Template
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
