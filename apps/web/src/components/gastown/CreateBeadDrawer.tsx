'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Drawer } from 'vaul';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { toast } from 'sonner';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { X, Plus, Sparkles, Loader2 } from 'lucide-react';

const MDXEditorComponent = dynamic(
  () => import('@/components/gastown/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })),
  { ssr: false }
);

type CreateBeadDrawerProps = {
  rigId: string;
  townId: string;
  isOpen: boolean;
  onClose: () => void;
};

export function CreateBeadDrawer({ rigId, townId, isOpen, onClose }: CreateBeadDrawerProps) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [aiLabels, setAiLabels] = useState<string[]>([]);
  const [labelInput, setLabelInput] = useState('');
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [startImmediately, setStartImmediately] = useState(false);
  const [userEditedTitle, setUserEditedTitle] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the sequence number of the most recently fired enrichment request.
  // When a response arrives we compare against this to discard stale results.
  const enrichSeqRef = useRef(0);
  // Mirror of userEditedTitle read inside async callbacks so the response
  // handler sees edits that happened after the request started.
  const userEditedTitleRef = useRef(false);

  useEffect(() => {
    userEditedTitleRef.current = userEditedTitle;
  }, [userEditedTitle]);

  const createBead = useMutation(
    trpc.gastown.createBead.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        toast.success(startImmediately ? 'Work dispatched' : 'Bead created — notifying mayor');
        handleClose();
      },
      onError: err => toast.error(err.message),
    })
  );

  const enrichBead = useMutation(trpc.gastown.enrichBead.mutationOptions());

  // Reset state when drawer opens/closes
  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setBody('');
      setLabels([]);
      setAiLabels([]);
      setLabelInput('');
      setShowLabelInput(false);
      setStartImmediately(false);
      setUserEditedTitle(false);
      userEditedTitleRef.current = false;
      setIsEnriching(false);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      // Advance the sequence so any in-flight enrichment response is discarded
      enrichSeqRef.current++;
    }
  }, [isOpen]);

  // Debounced AI enrichment.
  // Advance the sequence number on every body change (not just when the
  // debounced request fires) so any in-flight response from a previous
  // edit is discarded the moment the user keeps typing. Without this, a
  // response to an older body could arrive before the debounce timer for
  // the newer body elapses and overwrite the draft with stale suggestions.
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const seq = ++enrichSeqRef.current;

    if (body.length > 20) {
      debounceRef.current = setTimeout(() => {
        setIsEnriching(true);
        enrichBead.mutate(
          { body, townId },
          {
            onSuccess: result => {
              // Discard the response if a newer edit has since superseded
              // this request or if the drawer has been closed and state reset.
              if (seq !== enrichSeqRef.current) return;
              setIsEnriching(false);
              if (result) {
                if (!userEditedTitleRef.current) {
                  setTitle(result.title);
                }
                setAiLabels(result.labels);
              }
            },
            onError: () => {
              if (seq !== enrichSeqRef.current) return;
              setIsEnriching(false);
            },
          }
        );
      }, 1500);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [body, townId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    onClose();
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    setUserEditedTitle(true);
  };

  const handleAddLabel = () => {
    const trimmed = labelInput.trim();
    if (trimmed && !labels.includes(trimmed) && !aiLabels.includes(trimmed)) {
      setLabels(prev => [...prev, trimmed]);
      setLabelInput('');
      setShowLabelInput(false);
    }
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddLabel();
    } else if (e.key === 'Escape') {
      setLabelInput('');
      setShowLabelInput(false);
    }
  };

  const removeLabel = (label: string) => {
    setLabels(prev => prev.filter(l => l !== label));
  };

  const removeAiLabel = (label: string) => {
    setAiLabels(prev => prev.filter(l => l !== label));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const allLabels = [...labels, ...aiLabels];
    createBead.mutate({
      rigId,
      townId,
      title: title.trim(),
      body: body.trim() || undefined,
      labels: allLabels.length > 0 ? allLabels : undefined,
      startImmediately,
    });
  };

  const allLabels = [...labels, ...aiLabels];

  return (
    <Drawer.Root open={isOpen} onOpenChange={open => !open && handleClose()} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Drawer.Content
          className="fixed top-0 right-0 bottom-0 z-50 flex w-[620px] max-w-[94vw] flex-col outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.08] bg-[oklch(0.12_0_0)]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <Drawer.Title className="text-base font-semibold text-white/90">
                New Bead
              </Drawer.Title>
              <button
                onClick={handleClose}
                className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
              <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
                {/* Title */}
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="text-xs font-medium text-white/50">Title</label>
                    {isEnriching && <Loader2 className="size-3 animate-spin text-white/30" />}
                  </div>
                  <Input
                    value={title}
                    onChange={handleTitleChange}
                    placeholder="What needs to be done?"
                    autoFocus
                    className={`border-white/[0.08] bg-black/20 text-white/90 placeholder:text-white/25 focus:border-white/20 ${isEnriching && !userEditedTitle ? 'animate-pulse' : ''}`}
                  />
                </div>

                {/* Labels */}
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label className="text-xs font-medium text-white/50">Labels</label>
                    {isEnriching && <Loader2 className="size-3 animate-spin text-white/30" />}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* AI-suggested labels */}
                    {aiLabels.map(label => (
                      <span
                        key={`ai-${label}`}
                        className="inline-flex items-center gap-1 rounded-md border border-[color:oklch(0.95_0.15_108_/_0.25)] bg-[color:oklch(0.95_0.15_108_/_0.08)] px-2 py-0.5 text-[11px] text-[color:oklch(0.95_0.15_108_/_0.8)]"
                      >
                        <Sparkles className="size-2.5" />
                        {label}
                        <button
                          type="button"
                          onClick={() => removeAiLabel(label)}
                          className="ml-0.5 opacity-60 hover:opacity-100"
                        >
                          <X className="size-2.5" />
                        </button>
                      </span>
                    ))}
                    {/* Manually added labels */}
                    {labels.map(label => (
                      <span
                        key={`manual-${label}`}
                        className="inline-flex items-center gap-1 rounded-md border border-white/[0.12] bg-white/[0.06] px-2 py-0.5 text-[11px] text-white/60"
                      >
                        {label}
                        <button
                          type="button"
                          onClick={() => removeLabel(label)}
                          className="ml-0.5 opacity-60 hover:opacity-100"
                        >
                          <X className="size-2.5" />
                        </button>
                      </span>
                    ))}
                    {/* Add label input */}
                    {showLabelInput ? (
                      <input
                        autoFocus
                        value={labelInput}
                        onChange={e => setLabelInput(e.target.value)}
                        onKeyDown={handleLabelKeyDown}
                        onBlur={handleAddLabel}
                        placeholder="label name"
                        className="rounded-md border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/70 placeholder:text-white/25 outline-none focus:border-white/20"
                        style={{ width: '80px' }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowLabelInput(true)}
                        className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-white/[0.1] px-2 py-0.5 text-[11px] text-white/30 transition-colors hover:border-white/20 hover:text-white/50"
                      >
                        <Plus className="size-2.5" />
                        add
                      </button>
                    )}
                    {allLabels.length === 0 && !showLabelInput && (
                      <span className="text-[11px] text-white/20">No labels yet</span>
                    )}
                  </div>
                </div>

                {/* Body / MDXEditor */}
                <div className="flex-1">
                  <label className="mb-1.5 block text-xs font-medium text-white/50">
                    Description
                  </label>
                  <MDXEditorComponent
                    value={body}
                    onChange={setBody}
                    placeholder="Describe the work..."
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-white/[0.06] px-5 py-4">
                {/* Start immediately toggle */}
                <div className="mb-4">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={startImmediately}
                      onChange={e => setStartImmediately(e.target.checked)}
                      className="mt-0.5 size-4 cursor-pointer rounded border-white/20 bg-white/5 accent-[color:oklch(0.95_0.15_108)]"
                    />
                    <div>
                      <span className="text-sm text-white/75">Start immediately</span>
                      {!startImmediately && (
                        <p className="mt-0.5 text-xs text-white/35">
                          The mayor will be notified and can help plan this work
                        </p>
                      )}
                    </div>
                  </label>
                </div>

                {/* Action buttons */}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="md" type="button" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="md"
                    type="submit"
                    disabled={!title.trim() || createBead.isPending}
                    className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
                  >
                    {createBead.isPending ? (
                      <>
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      'Create'
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
