'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/Button';
import { BabysitPrPanel } from '@/components/gastown/BabysitPrPanel';
import { toast } from 'sonner';

type SlingDialogProps = {
  rigId: string;
  isOpen: boolean;
  onClose: () => void;
};

const MODEL_OPTIONS = [
  { value: 'kilo/kilo-auto/frontier', label: 'Auto' },
  { value: 'kilo/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'kilo/claude-opus-4-20250514', label: 'Claude Opus 4' },
  { value: 'kilo/gpt-4.1', label: 'GPT 4.1' },
  { value: 'kilo/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

const TAB_STORAGE_KEY = 'sling-dialog-last-tab';

function getStoredTab(): string {
  if (typeof window === 'undefined') return 'sling';
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) ?? 'sling';
  } catch {
    return 'sling';
  }
}

function storeTab(tab: string) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

export function SlingDialog({ rigId, isOpen, onClose }: SlingDialogProps) {
  const [activeTab, setActiveTab] = useState(getStoredTab);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isOpen) {
      setActiveTab(getStoredTab());
    }
  }, [isOpen]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    storeTab(tab);
  };

  const sling = useMutation(
    trpc.gastown.sling.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.getRig.queryKey() });
        toast.success(`Work slung to ${result.agent.name}`);
        setTitle('');
        setBody('');
        setModel(MODEL_OPTIONS[0].value);
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    sling.mutate({
      rigId,
      title: title.trim(),
      body: body.trim() || undefined,
      model,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle>Sling Work</DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="mb-2 w-full">
            <TabsTrigger value="sling" className="flex-1">
              Sling work
            </TabsTrigger>
            <TabsTrigger value="babysit" className="flex-1">
              Babysit existing PR
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sling">
            <form onSubmit={handleSubmit}>
              <div className="space-y-4 py-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-white/70">Title</label>
                  <Input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="What needs to be done?"
                    autoFocus={activeTab === 'sling'}
                    className="border-white/10 bg-black/25"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-white/70">
                    Description (optional)
                  </label>
                  <Textarea
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    placeholder="Additional context or requirements..."
                    rows={4}
                    className="border-white/10 bg-black/25"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-white/70">Model</label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="md" type="button" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  type="submit"
                  disabled={!title.trim() || sling.isPending}
                  className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
                >
                  {sling.isPending ? 'Slinging...' : 'Sling'}
                </Button>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="babysit">
            <BabysitPrPanel rigId={rigId} onClose={onClose} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
