'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  useCustomLlms,
  useUpsertCustomLlm,
  useDeleteCustomLlm,
} from '@/app/admin/api/custom-llms/hooks';
import { CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { toast } from 'sonner';
import { Plus, Pencil } from 'lucide-react';
import Editor from '@monaco-editor/react';

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  publicId: string;
  definitionJson: string;
  validationError: string | null;
};

const INITIAL_DEFINITION: CustomLlmDefinition = {
  internal_id: '',
  display_name: '',
  context_length: 0,
  max_completion_tokens: 0,
  base_url: '',
  api_key: '',
  organization_ids: [],
};

const initialEditorState: EditorState = {
  open: false,
  mode: 'create',
  publicId: '',
  definitionJson: JSON.stringify(INITIAL_DEFINITION, null, 2),
  validationError: null,
};

export function CustomLlmsContent() {
  const { data, isLoading } = useCustomLlms();
  const upsertMutation = useUpsertCustomLlm();
  const deleteMutation = useDeleteCustomLlm();
  const [editor, setEditor] = useState<EditorState>(initialEditorState);

  const openCreate = useCallback(() => {
    setEditor({
      open: true,
      mode: 'create',
      publicId: '',
      definitionJson: JSON.stringify(INITIAL_DEFINITION, null, 2),
      validationError: null,
    });
  }, []);

  const openEdit = useCallback((publicId: string, definition: CustomLlmDefinition) => {
    setEditor({
      open: true,
      mode: 'edit',
      publicId,
      definitionJson: JSON.stringify(definition, null, 2),
      validationError: null,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(initialEditorState);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editor.publicId.trim()) {
      setEditor(prev => ({ ...prev, validationError: 'public_id is required' }));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.definitionJson);
    } catch {
      setEditor(prev => ({ ...prev, validationError: 'Invalid JSON syntax' }));
      return;
    }

    const result = CustomLlmDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const messages = result.error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      setEditor(prev => ({ ...prev, validationError: messages }));
      return;
    }

    try {
      await upsertMutation.mutateAsync({
        public_id: editor.publicId,
        definition: result.data,
      });
      toast.success(editor.mode === 'create' ? 'Custom LLM created' : 'Custom LLM updated');
      closeEditor();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    }
  }, [editor, upsertMutation, closeEditor]);

  const handleDelete = useCallback(
    async (publicId: string) => {
      try {
        await deleteMutation.mutateAsync({ public_id: publicId });
        toast.success('Custom LLM deleted');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to delete');
      }
    },
    [deleteMutation]
  );

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Custom LLMs</h2>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Custom LLM
        </Button>
      </div>

      <p className="text-muted-foreground">
        Manage custom LLM definitions stored in the <code>custom_llm2</code> table. Each entry has a{' '}
        <code>public_id</code> and a JSON <code>definition</code> that is validated against{' '}
        <code>CustomLlmDefinitionSchema</code>.
      </p>

      {isLoading ? (
        <div className="text-center">Loading...</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Public ID</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead>Internal ID</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-center">
                  No custom LLMs defined yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(item => (
              <TableRow key={item.public_id}>
                <TableCell className="font-mono text-sm">{item.public_id}</TableCell>
                <TableCell>{item.definition.display_name}</TableCell>
                <TableCell className="font-mono text-sm">{item.definition.internal_id}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(item.public_id, item.definition)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <InlineDeleteConfirmation
                      onDelete={() => handleDelete(item.public_id)}
                      isLoading={deleteMutation.isPending}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={editor.open}
        onOpenChange={open => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {editor.mode === 'create' ? 'Add Custom LLM' : `Edit: ${editor.publicId}`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="public-id">Public ID</Label>
              <Input
                id="public-id"
                value={editor.publicId}
                onChange={e =>
                  setEditor(prev => ({
                    ...prev,
                    publicId: e.target.value,
                    validationError: null,
                  }))
                }
                disabled={editor.mode === 'edit'}
                placeholder="e.g. kilo-internal/my-custom-model"
                className="font-mono"
              />
            </div>

            <div>
              <Label>Definition (JSON)</Label>
              <div className="border-input mt-1 overflow-hidden rounded-md border">
                <Editor
                  height="400px"
                  defaultLanguage="json"
                  value={editor.definitionJson}
                  onChange={(value: string | undefined) =>
                    setEditor(prev => ({
                      ...prev,
                      definitionJson: value ?? '',
                      validationError: null,
                    }))
                  }
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    formatOnPaste: true,
                  }}
                />
              </div>
            </div>

            {editor.validationError && (
              <pre className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap">
                {editor.validationError}
              </pre>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
