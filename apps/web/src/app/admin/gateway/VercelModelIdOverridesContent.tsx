'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { VercelModelIdOverrideSchema } from '@kilocode/db/schema-types';
import { formatZodError } from '@/lib/zod/format-zod-error';

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  openrouterModelId: string;
  vercelModelId: string;
  validationError: string | null;
};

const closedEditor: EditorState = {
  open: false,
  mode: 'create',
  openrouterModelId: '',
  vercelModelId: '',
  validationError: null,
};

export function VercelModelIdOverridesContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(trpc.admin.vercelModelIdOverrides.list.queryOptions());
  const [editor, setEditor] = useState<EditorState>(closedEditor);

  const invalidateList = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.admin.vercelModelIdOverrides.list.queryKey(),
    });

  const upsertMutation = useMutation(
    trpc.admin.vercelModelIdOverrides.upsert.mutationOptions({
      onSuccess: () => {
        void invalidateList();
      },
    })
  );

  const deleteMutation = useMutation(
    trpc.admin.vercelModelIdOverrides.delete.mutationOptions({
      onSuccess: () => {
        void invalidateList();
      },
    })
  );

  const items = data?.items ?? [];

  function openCreate() {
    setEditor({ ...closedEditor, open: true });
  }

  function openEdit(openrouterModelId: string, vercelModelId: string) {
    setEditor({ ...closedEditor, open: true, mode: 'edit', openrouterModelId, vercelModelId });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = VercelModelIdOverrideSchema.safeParse({
      openrouter_model_id: editor.openrouterModelId,
      vercel_model_id: editor.vercelModelId,
    });
    if (!parsed.success) {
      setEditor(prev => ({ ...prev, validationError: formatZodError(parsed.error) }));
      return;
    }
    if (
      editor.mode === 'create' &&
      items.some(item => item.openrouter_model_id === parsed.data.openrouter_model_id)
    ) {
      setEditor(prev => ({
        ...prev,
        validationError: `An override for ${parsed.data.openrouter_model_id} already exists. Edit it instead.`,
      }));
      return;
    }
    try {
      await upsertMutation.mutateAsync(parsed.data);
      toast.success(editor.mode === 'create' ? 'Override added' : 'Override updated');
      setEditor(closedEditor);
    } catch (error) {
      toast.error(formatZodError(error));
    }
  }

  async function handleDelete(openrouterModelId: string) {
    try {
      await deleteMutation.mutateAsync({ openrouter_model_id: openrouterModelId });
      toast.success('Override deleted');
    } catch (error) {
      toast.error(formatZodError(error));
    }
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Model ID Overrides</CardTitle>
            <CardDescription>
              Overrides that map a full OpenRouter model ID to a full Vercel AI Gateway model ID,
              stored in the <code>vercel_model_id_overrides</code> column of{' '}
              <code>ai_gateway_config</code>. The gateway does not read these overrides yet;
              requests still use the built-in mapping.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            Add override
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>OpenRouter model ID</TableHead>
                <TableHead>Vercel model ID</TableHead>
                <TableHead>Built-in mapping</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground text-center text-sm">
                    No overrides. The built-in mapping applies to every model.
                  </TableCell>
                </TableRow>
              )}
              {items.map(item => (
                <TableRow key={item.openrouter_model_id}>
                  <TableCell className="font-mono text-sm">{item.openrouter_model_id}</TableCell>
                  <TableCell className="font-mono text-sm">{item.vercel_model_id}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {item.builtin_vercel_model_id}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit override for ${item.openrouter_model_id}`}
                        onClick={() => openEdit(item.openrouter_model_id, item.vercel_model_id)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <InlineDeleteConfirmation
                        onDelete={() => handleDelete(item.openrouter_model_id)}
                        isLoading={deleteMutation.isPending}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={editor.open}
        onOpenChange={open => {
          if (!open) setEditor(closedEditor);
        }}
      >
        <DialogContent>
          <form className="flex flex-col gap-4" onSubmit={handleSave}>
            <DialogHeader>
              <DialogTitle>
                {editor.mode === 'create' ? 'Add override' : 'Edit override'}
              </DialogTitle>
              <DialogDescription>
                Use full model IDs, for example <code>meta/muse-wonder</code> →{' '}
                <code>meta/muse-wonder-1.0</code>.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="vercel-override-openrouter-id">OpenRouter model ID</Label>
              <Input
                id="vercel-override-openrouter-id"
                className="font-mono"
                placeholder="provider/model-id"
                value={editor.openrouterModelId}
                disabled={editor.mode === 'edit'}
                onChange={event =>
                  setEditor(prev => ({
                    ...prev,
                    openrouterModelId: event.target.value,
                    validationError: null,
                  }))
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="vercel-override-vercel-id">Vercel model ID</Label>
              <Input
                id="vercel-override-vercel-id"
                className="font-mono"
                placeholder="provider/model-id"
                value={editor.vercelModelId}
                onChange={event =>
                  setEditor(prev => ({
                    ...prev,
                    vercelModelId: event.target.value,
                    validationError: null,
                  }))
                }
              />
            </div>
            {editor.validationError && (
              <pre
                className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap"
                role="alert"
              >
                {editor.validationError}
              </pre>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditor(closedEditor)}>
                Cancel
              </Button>
              <Button type="submit" disabled={upsertMutation.isPending}>
                {upsertMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
