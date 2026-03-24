'use client';

import { useRef, useEffect, useCallback, useState, memo } from 'react';
import type { KeyboardEvent, ChangeEvent } from 'react';
import { AlertTriangle, Paperclip, Send, Square, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useImageUpload } from '@/hooks/useImageUpload';
import { ImagePreviewStrip } from '@/components/app-builder/ImagePreviewStrip';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import type { Images } from '@/lib/images-schema';

export type PromptInputProps = {
  // Core functionality
  onSubmit: (value: string, images?: Images) => Promise<void>;

  // Variants
  variant: 'landing' | 'chat';

  // State
  disabled?: boolean;
  isSubmitting?: boolean;

  // Interrupt functionality (for stopping streaming)
  onInterrupt?: () => void;
  isInterrupting?: boolean;

  // Image upload
  messageUuid: string;
  organizationId?: string;
  maxImages?: number;
  onImagesChange?: (hasImages: boolean) => void;

  // Model selection (optional)
  models?: ModelOption[];
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  isLoadingModels?: boolean;
  modelsError?: string;

  // Customization
  placeholder?: string;

  // Warning state (e.g., images with non-vision model)
  warningMessage?: string;
};

/**
 * Memoized bottom bar to prevent re-renders during parent updates.
 * This contains the model selector which is expensive to render.
 * The memo is necessary because parent components have React Query hooks
 * that cause periodic re-renders, and some props (like `models` array) get
 * recreated each time even though their content is the same.
 */
const BottomBar = memo(function BottomBar({
  isLanding,
  isChat,
  disabled,
  isSubmitting,
  hasUploadingImages,
  onAttachClick,
  onModelChange,
  models,
  selectedModel,
  isLoadingModels,
  modelsError,
  warningMessage,
  onSubmit,
  onInterrupt,
  isInterrupting,
}: {
  isLanding: boolean;
  isChat: boolean;
  disabled: boolean;
  isSubmitting: boolean;
  hasUploadingImages: boolean;
  onAttachClick: () => void;
  onModelChange?: (modelId: string) => void;
  models?: ModelOption[];
  selectedModel?: string;
  isLoadingModels?: boolean;
  modelsError?: string;
  warningMessage?: string;
  onSubmit: () => void;
  onInterrupt?: () => void;
  isInterrupting: boolean;
}) {
  // Compute submit disabled state here, without value dependency
  // Value emptiness is checked in handleSubmit
  const isSubmitDisabled = disabled || isSubmitting || hasUploadingImages;
  return (
    <div className={cn('flex items-center gap-2', isLanding ? 'p-4 pt-2' : 'p-3 pt-2')}>
      {/* Attach button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onAttachClick}
        disabled={disabled || isSubmitting}
        className="h-9 gap-1.5 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
      >
        <Paperclip className="h-4 w-4" />
        <span className={cn(isChat && 'sr-only')}>Attach</span>
      </Button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Model selector (only shown when models are provided) */}
      {onModelChange && (
        <ModelCombobox
          variant="compact"
          models={models ?? []}
          value={selectedModel}
          onValueChange={onModelChange}
          isLoading={isLoadingModels}
          error={modelsError}
          placeholder="Model"
          className="w-56 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        />
      )}

      {/* Submit button or warning indicator */}
      {warningMessage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={isLanding ? 'default' : 'icon'}
              className={cn(
                'h-9 cursor-help border border-amber-500/50 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 hover:text-amber-400',
                !isLanding && 'w-9'
              )}
            >
              <AlertTriangle className="h-4 w-4" />
              {isLanding && <span>Submit</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {warningMessage}
          </TooltipContent>
        </Tooltip>
      ) : isLanding ? (
        <Button
          type="button"
          variant="primary"
          onClick={onSubmit}
          disabled={isSubmitDisabled}
          className="h-9"
        >
          <Send className="h-4 w-4" />
          Submit
        </Button>
      ) : isSubmitting && onInterrupt ? (
        <Button
          type="button"
          variant="destructive"
          size="icon"
          onClick={onInterrupt}
          disabled={isInterrupting}
          className="h-9 w-9"
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="icon"
          onClick={onSubmit}
          disabled={isSubmitDisabled}
          className="h-9 w-9"
        >
          <Send className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
});

export function PromptInput({
  onSubmit,
  variant,
  disabled = false,
  isSubmitting = false,
  onInterrupt,
  isInterrupting = false,
  messageUuid,
  organizationId,
  maxImages,
  onImagesChange,
  models,
  selectedModel,
  onModelChange,
  isLoadingModels,
  modelsError,
  placeholder,
  warningMessage,
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState('');
  // Ref to access current value in handleSubmit without adding localValue to dependencies
  const localValueRef = useRef(localValue);
  localValueRef.current = localValue;

  const {
    images,
    addFiles,
    removeImage,
    clearImages,
    hasUploadingImages,
    getImagesData,
    isDragging,
    dragHandlers,
  } = useImageUpload({
    messageUuid,
    organizationId,
    maxImages,
  });

  const isLanding = variant === 'landing';
  const isChat = variant === 'chat';

  // Notify parent when images change
  useEffect(() => {
    onImagesChange?.(images.length > 0);
  }, [images.length, onImagesChange]);

  // Compute default placeholder based on variant
  const effectivePlaceholder =
    placeholder ?? (isLanding ? 'Describe the app you want to build...' : 'Describe changes...');

  // Auto-resize textarea - done synchronously via ref to avoid React render churn
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = isLanding ? 300 : 200;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [isLanding]);

  // Initial resize on mount and when localValue changes (for controlled sync)
  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, localValue]);

  const handleSubmit = useCallback(async () => {
    const valueToSubmit = localValueRef.current.trim();
    if (!valueToSubmit || disabled || isSubmitting || hasUploadingImages) return;

    const imagesData = getImagesData();
    try {
      await onSubmit(valueToSubmit, imagesData);
      setLocalValue('');
      clearImages();
    } catch {
      // Don't clear on error - content remains for retry
    }
  }, [disabled, isSubmitting, hasUploadingImages, getImagesData, onSubmit, clearImages]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Ignore keyboard events during IME composition (Chinese, Japanese, Korean input)
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      if (isLanding) {
        // Landing: Cmd/Ctrl+Enter to submit
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void handleSubmit();
        }
      } else {
        // Chat: Enter to submit, Shift+Enter for newline
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void handleSubmit();
        }
      }
    },
    [isLanding, handleSubmit]
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setLocalValue(e.target.value);
      resizeTextarea();
    },
    [resizeTextarea]
  );

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
        // Reset file input so the same file can be selected again
        e.target.value = '';
      }
    },
    [addFiles]
  );

  return (
    <div
      className={cn(
        'relative w-full',
        isLanding && 'rounded-xl border border-zinc-700 bg-zinc-900/50',
        isChat && 'bg-background border-t'
      )}
      {...dragHandlers}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div
          className={cn(
            'border-primary/60 bg-primary/5 absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed backdrop-blur-[2px]',
            isLanding ? 'rounded-xl' : 'rounded-none'
          )}
        >
          <div className="flex flex-col items-center gap-3">
            <div className="bg-primary/10 rounded-full p-4">
              <Upload className="text-primary h-6 w-6" />
            </div>
            <span className="text-primary text-sm font-medium">Drop images here</span>
          </div>
        </div>
      )}

      {/* Textarea */}
      <div className={cn(isLanding ? 'p-4 pb-0' : 'p-3 pb-0', images.length > 0 && 'pb-2')}>
        <Textarea
          ref={textareaRef}
          value={localValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={effectivePlaceholder}
          disabled={disabled || isSubmitting}
          className={cn(
            'resize-none border-none bg-transparent px-0 shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
            isLanding && 'min-h-[120px] text-base md:min-h-[150px]',
            isChat && 'min-h-[56px] md:min-h-[60px]'
          )}
        />
      </div>

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className={cn(isLanding ? 'px-4 pb-2' : 'px-3 pb-1')}>
          <ImagePreviewStrip
            images={images}
            onRemove={removeImage}
            size={isLanding ? 'default' : 'compact'}
          />
          <p className="mt-1.5 text-xs text-zinc-500">
            Tip: Reference as &quot;Image 1&quot;, &quot;Image 2&quot;, etc. in your prompt
          </p>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Bottom bar with attach, model selector, and submit */}
      <BottomBar
        isLanding={isLanding}
        isChat={isChat}
        disabled={disabled}
        isSubmitting={isSubmitting}
        hasUploadingImages={hasUploadingImages}
        onAttachClick={handleAttachClick}
        onModelChange={onModelChange}
        models={models}
        selectedModel={selectedModel}
        isLoadingModels={isLoadingModels}
        modelsError={modelsError}
        warningMessage={warningMessage}
        onSubmit={handleSubmit}
        onInterrupt={onInterrupt}
        isInterrupting={isInterrupting}
      />

      {/* Hint text for chat variant */}
      {isChat && (
        <p className="px-3 pb-2 text-xs text-zinc-500">
          Press Enter to send, Shift+Enter for new line
        </p>
      )}
    </div>
  );
}
