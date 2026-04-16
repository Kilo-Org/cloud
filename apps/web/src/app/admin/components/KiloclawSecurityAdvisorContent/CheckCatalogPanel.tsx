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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

type Severity = 'critical' | 'warn' | 'info';

/** Narrow the DB-returned severity string to the Severity union via a
 * discriminated check, falling back to 'warn' on unexpected values.
 * The DB has a CHECK constraint, but we avoid a bare `as` cast per the
 * repo's type-safety standards.
 *
 * If the fallback ever fires, something has gone wrong (manual SQL edit,
 * schema drift). Surface it so the admin doesn't silently save 'warn'
 * back over whatever-invalid-value the row actually holds. */
function toSeverity(value: string): Severity {
  if (value === 'critical' || value === 'warn' || value === 'info') return value;
  console.warn(
    `[SecurityAdvisor] CheckCatalogPanel: row has invalid severity "${value}"; displaying 'warn' as fallback. Verify the row in the DB and re-save to correct.`
  );
  return 'warn';
}

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  check_id: string;
  severity: Severity;
  explanation: string;
  risk: string;
  is_active: boolean;
};

const initialEditor: EditorState = {
  open: false,
  mode: 'create',
  id: null,
  check_id: '',
  severity: 'warn',
  explanation: '',
  risk: '',
  is_active: true,
};

export function CheckCatalogPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.admin.securityAdvisorContent.checkCatalog.list.queryKey();

  const { data, isLoading } = useQuery(
    trpc.admin.securityAdvisorContent.checkCatalog.list.queryOptions()
  );
  const upsertMutation = useMutation(
    trpc.admin.securityAdvisorContent.checkCatalog.upsert.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );
  const deleteMutation = useMutation(
    trpc.admin.securityAdvisorContent.checkCatalog.delete.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
    })
  );

  const [editor, setEditor] = useState<EditorState>(initialEditor);

  const openCreate = useCallback(() => setEditor({ ...initialEditor, open: true }), []);
  const openEdit = useCallback(
    (row: {
      id: string;
      check_id: string;
      severity: string;
      explanation: string;
      risk: string;
      is_active: boolean;
    }) =>
      setEditor({
        open: true,
        mode: 'edit',
        id: row.id,
        check_id: row.check_id,
        severity: toSeverity(row.severity),
        explanation: row.explanation,
        risk: row.risk,
        is_active: row.is_active,
      }),
    []
  );
  const close = useCallback(() => setEditor(initialEditor), []);

  const save = useCallback(async () => {
    if (!editor.check_id.trim() || !editor.explanation.trim() || !editor.risk.trim()) {
      toast.error('check_id, explanation, and risk are required');
      return;
    }
    try {
      await upsertMutation.mutateAsync({
        check_id: editor.check_id.trim(),
        severity: editor.severity,
        explanation: editor.explanation,
        risk: editor.risk,
        is_active: editor.is_active,
      });
      toast.success(editor.mode === 'create' ? 'Check created' : 'Check updated');
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [editor, upsertMutation, close]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMutation.mutateAsync({ id });
        toast.success('Check deleted');
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
            The catalog of <code>checkId</code>s we recognize. When a finding's <code>checkId</code>{' '}
            is in this catalog, the server overrides the client's severity and replaces its
            description with our authoritative copy. Findings not in the catalog pass through using
            whatever the plugin client reported.
          </p>
          <p className="mt-2">
            <strong>Each check has:</strong> a Check ID, a Severity (critical / warn / info), an
            Explanation paragraph (what the finding means), and a Risk paragraph (why it matters).
            Click <em>Edit</em> to see or change all fields.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Check
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center">Loading...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Check ID</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Explanation</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No checks in the catalog yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">{row.check_id}</TableCell>
                <TableCell>{row.severity}</TableCell>
                <TableCell className="text-muted-foreground max-w-md truncate text-sm">
                  {row.explanation}
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
              {editor.mode === 'create' ? 'Add Check' : `Edit: ${editor.check_id}`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="tpl-check-id">Check ID</Label>
              <Input
                id="tpl-check-id"
                value={editor.check_id}
                disabled={editor.mode === 'edit'}
                onChange={e => setEditor(prev => ({ ...prev, check_id: e.target.value }))}
                placeholder="e.g. auth.no_authentication"
                className="font-mono"
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="tpl-severity">Severity</Label>
              <Select
                value={editor.severity}
                onValueChange={value =>
                  setEditor(prev => ({ ...prev, severity: value as Severity }))
                }
              >
                <SelectTrigger id="tpl-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">critical</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="tpl-explanation">Explanation</Label>
              <Textarea
                id="tpl-explanation"
                rows={4}
                value={editor.explanation}
                onChange={e => setEditor(prev => ({ ...prev, explanation: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div>
              <Label htmlFor="tpl-risk">Risk</Label>
              <Textarea
                id="tpl-risk"
                rows={4}
                value={editor.risk}
                onChange={e => setEditor(prev => ({ ...prev, risk: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="tpl-active"
                checked={editor.is_active}
                onCheckedChange={checked =>
                  setEditor(prev => ({ ...prev, is_active: checked === true }))
                }
              />
              <Label htmlFor="tpl-active">Active</Label>
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
