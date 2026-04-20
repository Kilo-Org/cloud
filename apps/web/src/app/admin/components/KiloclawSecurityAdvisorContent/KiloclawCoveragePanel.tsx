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
  area: string;
  summary: string;
  detail: string;
  matchCheckIdsText: string;
  is_active: boolean;
};

const initialEditor: EditorState = {
  open: false,
  mode: 'create',
  id: null,
  area: '',
  summary: '',
  detail: '',
  matchCheckIdsText: '',
  is_active: true,
};

function parseMatchIds(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function KiloclawCoveragePanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.admin.securityAdvisorContent.kiloclawCoverage.list.queryKey();

  const { data, isLoading } = useQuery(
    trpc.admin.securityAdvisorContent.kiloclawCoverage.list.queryOptions()
  );
  const upsertMutation = useMutation(
    trpc.admin.securityAdvisorContent.kiloclawCoverage.upsert.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );
  const deleteMutation = useMutation(
    trpc.admin.securityAdvisorContent.kiloclawCoverage.delete.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );

  const [editor, setEditor] = useState<EditorState>(initialEditor);

  const openCreate = useCallback(() => setEditor({ ...initialEditor, open: true }), []);
  const openEdit = useCallback(
    (row: {
      id: string;
      area: string;
      summary: string;
      detail: string;
      match_check_ids: string[];
      is_active: boolean;
    }) =>
      setEditor({
        open: true,
        mode: 'edit',
        id: row.id,
        area: row.area,
        summary: row.summary,
        detail: row.detail,
        matchCheckIdsText: row.match_check_ids.join('\n'),
        is_active: row.is_active,
      }),
    []
  );
  const close = useCallback(() => setEditor(initialEditor), []);

  const save = useCallback(async () => {
    if (!editor.area.trim() || !editor.summary.trim() || !editor.detail.trim()) {
      toast.error('area, summary, and detail are required');
      return;
    }
    try {
      await upsertMutation.mutateAsync({
        area: editor.area.trim(),
        summary: editor.summary,
        detail: editor.detail,
        match_check_ids: parseMatchIds(editor.matchCheckIdsText),
        is_active: editor.is_active,
      });
      toast.success(editor.mode === 'create' ? 'Coverage area created' : 'Coverage area updated');
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [editor, upsertMutation, close]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMutation.mutateAsync({ id });
        toast.success('Coverage area deleted');
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
            How KiloClaw handles each security area. Each entry covers a set of related{' '}
            <code>checkId</code>s. Shown in the report under every matching finding as either{' '}
            <em>"How KiloClaw handles this"</em> (for OpenClaw users) or a divergence warning (for
            KiloClaw users).
          </p>
          <p className="mt-2">
            <strong>Each entry has:</strong> an Area name (e.g. <code>authentication</code>), a
            one-line Summary, a longer Detail paragraph, and a list of <code>checkId</code>s this
            coverage applies to. Click <em>Edit</em> to see or change all fields.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Coverage Area
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center">Loading...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Area</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Match Check IDs</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No coverage areas defined yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.area}</TableCell>
                <TableCell className="text-muted-foreground max-w-sm truncate text-sm">
                  {row.summary}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.match_check_ids.join(', ')}
                </TableCell>
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
              {editor.mode === 'create' ? 'Add Coverage Area' : `Edit: ${editor.area}`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="area-name">Area</Label>
              <Input
                id="area-name"
                value={editor.area}
                disabled={editor.mode === 'edit'}
                onChange={e => setEditor(prev => ({ ...prev, area: e.target.value }))}
                placeholder="e.g. authentication"
                className="font-mono"
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="area-summary">Summary</Label>
              <Textarea
                id="area-summary"
                rows={2}
                value={editor.summary}
                onChange={e => setEditor(prev => ({ ...prev, summary: e.target.value }))}
                maxLength={2000}
              />
            </div>
            <div>
              <Label htmlFor="area-detail">Detail</Label>
              <Textarea
                id="area-detail"
                rows={5}
                value={editor.detail}
                onChange={e => setEditor(prev => ({ ...prev, detail: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div>
              <Label htmlFor="area-match">Match Check IDs (one per line or comma-separated)</Label>
              <Textarea
                id="area-match"
                rows={4}
                value={editor.matchCheckIdsText}
                onChange={e => setEditor(prev => ({ ...prev, matchCheckIdsText: e.target.value }))}
                placeholder="auth.no_authentication&#10;auth.weak_token"
                className="font-mono text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="area-active"
                checked={editor.is_active}
                onCheckedChange={checked =>
                  setEditor(prev => ({ ...prev, is_active: checked === true }))
                }
              />
              <Label htmlFor="area-active">Active</Label>
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
