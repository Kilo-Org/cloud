'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { toast } from 'sonner';
import { Plus, Pencil } from 'lucide-react';

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  key: string;
  value: string;
  description: string;
  is_active: boolean;
};

const initialEditor: EditorState = {
  open: false,
  mode: 'create',
  id: null,
  key: '',
  value: '',
  description: '',
  is_active: true,
};

export function ContentKeysPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.admin.securityAdvisorContent.content.list.queryKey();

  const { data, isLoading } = useQuery(
    trpc.admin.securityAdvisorContent.content.list.queryOptions()
  );
  const upsertMutation = useMutation(
    trpc.admin.securityAdvisorContent.content.upsert.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );
  const deleteMutation = useMutation(
    trpc.admin.securityAdvisorContent.content.delete.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );

  const [editor, setEditor] = useState<EditorState>(initialEditor);

  const openCreate = useCallback(() => setEditor({ ...initialEditor, open: true }), []);
  const openEdit = useCallback(
    (row: { id: string; key: string; value: string; description: string; is_active: boolean }) =>
      setEditor({
        open: true,
        mode: 'edit',
        id: row.id,
        key: row.key,
        value: row.value,
        description: row.description,
        is_active: row.is_active,
      }),
    []
  );
  const close = useCallback(() => setEditor(initialEditor), []);

  const save = useCallback(async () => {
    if (!editor.key.trim() || !editor.value.trim()) {
      toast.error('key and value are required');
      return;
    }
    try {
      await upsertMutation.mutateAsync({
        key: editor.key.trim(),
        value: editor.value,
        description: editor.description,
        is_active: editor.is_active,
      });
      toast.success(editor.mode === 'create' ? 'Content key created' : 'Content key updated');
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [editor, upsertMutation, close]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMutation.mutateAsync({ id });
        toast.success('Content key deleted');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete');
      }
    },
    [deleteMutation]
  );

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="text-muted-foreground max-w-3xl text-sm">
          <p>
            Editable chrome for the report — CTA heading/body, the framing templates that wrap every
            KiloClaw Coverage callout, and fallback text for unknown findings. Report structure
            (section headings, labels, summary-line formats) is <em>not</em> here — it's hardcoded
            in the report generator because it's formatting, not content.
          </p>
          <p className="mt-2">
            <strong>Each entry has:</strong> a Key (referenced by the report generator), a Value
            (the actual text), and an optional Description (an editor note). Values can contain{' '}
            <code>{'{placeholder}'}</code> tokens — supported ones are <code>{'{summary}'}</code>,{' '}
            <code>{'{detail}'}</code>, <code>{'{title}'}</code>, and <code>{'{checkId}'}</code>,
            substituted at render time.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Key
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center">Loading...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-center">
                  No content keys defined yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.key}</TableCell>
                <TableCell className="max-w-md truncate text-sm">{row.value}</TableCell>
                <TableCell>{row.is_active ? 'Yes' : 'No'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <InlineDeleteConfirmation
                      onDelete={() => handleDelete(row.id)}
                      isLoading={deleteMutation.isPending}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={editor.open} onOpenChange={open => !open && close()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor.mode === 'create' ? 'Add Content Key' : `Edit: ${editor.key}`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="key-name">Key</Label>
              <Input
                id="key-name"
                value={editor.key}
                disabled={editor.mode === 'edit'}
                onChange={e => setEditor(prev => ({ ...prev, key: e.target.value }))}
                placeholder="e.g. cta.headline"
                className="font-mono"
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="key-value">Value</Label>
              <Textarea
                id="key-value"
                rows={5}
                value={editor.value}
                onChange={e => setEditor(prev => ({ ...prev, value: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div>
              <Label htmlFor="key-desc">Description (editor note)</Label>
              <Textarea
                id="key-desc"
                rows={2}
                value={editor.description}
                onChange={e => setEditor(prev => ({ ...prev, description: e.target.value }))}
                maxLength={2000}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="key-active"
                checked={editor.is_active}
                onCheckedChange={checked =>
                  setEditor(prev => ({ ...prev, is_active: checked === true }))
                }
              />
              <Label htmlFor="key-active">Active</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
