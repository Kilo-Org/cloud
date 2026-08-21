'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  useCopyCustomLlm,
  useUpsertCustomLlm,
  useDeleteCustomLlm,
} from '@/app/admin/api/custom-llms/hooks';
import { CustomLlmCredentialsSchema, CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import type { CustomLlmCredentials, CustomLlmDefinition } from '@kilocode/db/schema-types';
import { deepStrict } from '@/lib/zod/deep-strict';
import { formatZodError } from '@/lib/zod/format-zod-error';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { toast } from 'sonner';
import { Copy as CopyIcon, Plus, Pencil } from 'lucide-react';
import Editor from '@monaco-editor/react';

const StrictCustomLlmDefinitionSchema = deepStrict(CustomLlmDefinitionSchema);
const StrictCustomLlmCredentialsSchema = deepStrict(CustomLlmCredentialsSchema);

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  publicId: string;
  credentialsJson: string;
  definitionJson: string;
  validationError: string | null;
};

type CopyState = {
  sourcePublicId: string;
  publicId: string;
  displayName: string;
  internalId: string;
  validationError: {
    field: 'publicId' | 'displayName' | 'internalId' | null;
    message: string;
  } | null;
};

const INITIAL_DEFINITION: CustomLlmDefinition = {
  internal_id: '',
  display_name: '',
  context_length: 0,
  max_completion_tokens: 0,
  base_url: '',
  organization_ids: [],
  group_ids: [],
};

const INITIAL_CREDENTIALS: CustomLlmCredentials = {
  type: 'api_key',
  api_key: '',
};

const initialEditorState: EditorState = {
  open: false,
  mode: 'create',
  publicId: '',
  credentialsJson: JSON.stringify(INITIAL_CREDENTIALS, null, 2),
  definitionJson: JSON.stringify(INITIAL_DEFINITION, null, 2),
  validationError: null,
};

export function CustomLlmsContent() {
  const { data, isLoading } = useCustomLlms();
  const upsertMutation = useUpsertCustomLlm();
  const copyMutation = useCopyCustomLlm();
  const deleteMutation = useDeleteCustomLlm();
  const [editor, setEditor] = useState<EditorState>(initialEditorState);
  const [copy, setCopy] = useState<CopyState | null>(null);

  const openCreate = useCallback(() => {
    setEditor({
      open: true,
      mode: 'create',
      publicId: '',
      credentialsJson: JSON.stringify(INITIAL_CREDENTIALS, null, 2),
      definitionJson: JSON.stringify(INITIAL_DEFINITION, null, 2),
      validationError: null,
    });
  }, []);

  const openEdit = useCallback((publicId: string, definition: CustomLlmDefinition) => {
    setEditor({
      open: true,
      mode: 'edit',
      publicId,
      credentialsJson: '',
      definitionJson: JSON.stringify(definition, null, 2),
      validationError: null,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(initialEditorState);
  }, []);

  const openCopy = useCallback(
    (sourcePublicId: string, sourceDisplayName: string, sourceInternalId: string) => {
      setCopy({
        sourcePublicId,
        publicId: sourcePublicId,
        displayName: sourceDisplayName,
        internalId: sourceInternalId,
        validationError: null,
      });
    },
    []
  );

  const closeCopy = useCallback(() => {
    setCopy(null);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!copy) return;

    const publicId = copy.publicId.trim();
    const displayName = copy.displayName.trim();
    const internalId = copy.internalId.trim();

    if (!publicId) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: { field: 'publicId', message: 'New public ID is required' },
            }
          : prev
      );
      return;
    }

    if (!publicId.startsWith(CUSTOM_LLM_PREFIX)) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: {
                field: 'publicId',
                message: `New public ID must start with "${CUSTOM_LLM_PREFIX}"`,
              },
            }
          : prev
      );
      return;
    }

    if (!displayName) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: { field: 'displayName', message: 'New display name is required' },
            }
          : prev
      );
      return;
    }

    if (!internalId) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: { field: 'internalId', message: 'New internal ID is required' },
            }
          : prev
      );
      return;
    }

    try {
      await copyMutation.mutateAsync({
        source_public_id: copy.sourcePublicId,
        public_id: publicId,
        display_name: displayName,
        internal_id: internalId,
      });
      toast.success('Custom LLM copied');
      closeCopy();
    } catch (error) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: { field: null, message: formatZodError(error) },
            }
          : prev
      );
    }
  }, [copy, copyMutation, closeCopy]);

  const handleSave = useCallback(async () => {
    const trimmedPublicId = editor.publicId.trim();
    if (!trimmedPublicId) {
      setEditor(prev => ({ ...prev, validationError: 'public_id is required' }));
      return;
    }

    if (!trimmedPublicId.startsWith(CUSTOM_LLM_PREFIX)) {
      setEditor(prev => ({
        ...prev,
        validationError: `public_id must start with "${CUSTOM_LLM_PREFIX}"`,
      }));
      return;
    }

    let parsedCredentials: CustomLlmCredentials | undefined = undefined;
    const trimmedCredentialsJson = editor.credentialsJson.trim();

    if (trimmedCredentialsJson) {
      let rawCredentials: unknown;
      try {
        rawCredentials = JSON.parse(trimmedCredentialsJson);
      } catch {
        setEditor(prev => ({ ...prev, validationError: 'Invalid credentials JSON syntax' }));
        return;
      }

      const credResult = StrictCustomLlmCredentialsSchema.safeParse(rawCredentials);
      if (!credResult.success) {
        setEditor(prev => ({
          ...prev,
          validationError: `Credentials error: ${formatZodError(credResult.error)}`,
        }));
        return;
      }
      parsedCredentials = credResult.data;
    }

    let parsedDefinition: unknown;
    try {
      parsedDefinition = JSON.parse(editor.definitionJson);
    } catch {
      setEditor(prev => ({ ...prev, validationError: 'Invalid definition JSON syntax' }));
      return;
    }

    const defResult = StrictCustomLlmDefinitionSchema.safeParse(parsedDefinition);
    if (!defResult.success) {
      setEditor(prev => ({ ...prev, validationError: formatZodError(defResult.error) }));
      return;
    }

    if (editor.mode === 'create' && !parsedCredentials) {
      setEditor(prev => ({
        ...prev,
        validationError: 'Credentials (JSON) are required when creating a custom LLM',
      }));
      return;
    }

    try {
      await upsertMutation.mutateAsync({
        public_id: trimmedPublicId,
        definition: defResult.data,
        credentials: parsedCredentials,
      });
      toast.success(editor.mode === 'create' ? 'Custom LLM created' : 'Custom LLM updated');
      closeEditor();
    } catch (error) {
      toast.error(formatZodError(error));
    }
  }, [editor, upsertMutation, closeEditor]);

  const handleDelete = useCallback(
    async (publicId: string) => {
      try {
        await deleteMutation.mutateAsync({ public_id: publicId });
        toast.success('Custom LLM deleted');
      } catch (error) {
        toast.error(formatZodError(error));
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
        <code>public_id</code>, encrypted credentials (such as API keys or Google Cloud
        service-account keys), and a JSON <code>definition</code> validated against{' '}
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
                      aria-label={`Edit ${item.public_id}`}
                      title="Edit custom LLM"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openCopy(
                          item.public_id,
                          item.definition.display_name,
                          item.definition.internal_id
                        )
                      }
                      aria-label={`Copy ${item.public_id}`}
                      title="Copy custom LLM"
                    >
                      <CopyIcon className="h-3 w-3" />
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
                placeholder={`e.g. ${CUSTOM_LLM_PREFIX}my-custom-model`}
                className="font-mono"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label>Credentials (JSON)</Label>
                {editor.mode === 'edit' && (
                  <span className="text-muted-foreground text-xs">
                    (optional: leave empty to keep existing encrypted credentials)
                  </span>
                )}
              </div>
              <div className="border-input mt-1 overflow-hidden rounded-md border">
                <Editor
                  height="160px"
                  defaultLanguage="json"
                  value={editor.credentialsJson}
                  onChange={(value: string | undefined) =>
                    setEditor(prev => ({
                      ...prev,
                      credentialsJson: value ?? '',
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
              {!editor.credentialsJson.trim() && (
                <div className="bg-muted text-muted-foreground mt-2 rounded-md p-3 text-xs">
                  <p>Add an API key using one of these credential formats:</p>
                  <pre className="text-foreground mt-2 overflow-x-auto font-mono whitespace-pre-wrap">
                    {`{
  "type": "api_key",
  "api_key": "YOUR_API_KEY"
}`}
                  </pre>
                  <p className="mt-2">
                    Use{' '}
                    <code className="text-foreground">&quot;type&quot;: &quot;x-api-key&quot;</code>{' '}
                    instead when the provider expects an{' '}
                    <code className="text-foreground">x-api-key</code> header.
                  </p>
                </div>
              )}
            </div>

            <div>
              <Label>Definition (JSON)</Label>
              <div className="border-input mt-1 overflow-hidden rounded-md border">
                <Editor
                  height="340px"
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

      <Dialog
        open={copy !== null}
        onOpenChange={open => {
          if (!open && !copyMutation.isPending) closeCopy();
        }}
      >
        <DialogContent showCloseButton={!copyMutation.isPending}>
          <DialogHeader>
            <DialogTitle>Copy Custom LLM</DialogTitle>
            <DialogDescription>
              Copy the definition and encrypted credentials from{' '}
              <code className="font-mono">{copy?.sourcePublicId}</code>. Enter a new public ID and
              adjust the display name and internal ID for the copy.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="copy-public-id">New Public ID</Label>
              <Input
                id="copy-public-id"
                value={copy?.publicId ?? ''}
                onChange={event =>
                  setCopy(prev =>
                    prev ? { ...prev, publicId: event.target.value, validationError: null } : prev
                  )
                }
                placeholder={`e.g. ${CUSTOM_LLM_PREFIX}my-copied-model`}
                className="font-mono"
                aria-invalid={copy?.validationError?.field === 'publicId'}
                aria-describedby={
                  copy?.validationError?.field === 'publicId' ? 'copy-validation-error' : undefined
                }
              />
            </div>

            <div>
              <Label htmlFor="copy-display-name">New Display Name</Label>
              <Input
                id="copy-display-name"
                value={copy?.displayName ?? ''}
                onChange={event =>
                  setCopy(prev =>
                    prev
                      ? { ...prev, displayName: event.target.value, validationError: null }
                      : prev
                  )
                }
                placeholder="e.g. My copied model"
                aria-invalid={copy?.validationError?.field === 'displayName'}
                aria-describedby={
                  copy?.validationError?.field === 'displayName'
                    ? 'copy-validation-error'
                    : undefined
                }
              />
            </div>

            <div>
              <Label htmlFor="copy-internal-id">New Internal ID</Label>
              <Input
                id="copy-internal-id"
                value={copy?.internalId ?? ''}
                onChange={event =>
                  setCopy(prev =>
                    prev ? { ...prev, internalId: event.target.value, validationError: null } : prev
                  )
                }
                placeholder="e.g. copied-model"
                className="font-mono"
                aria-invalid={copy?.validationError?.field === 'internalId'}
                aria-describedby={
                  copy?.validationError?.field === 'internalId'
                    ? 'copy-validation-error'
                    : undefined
                }
              />
            </div>

            {copy?.validationError && (
              <p
                id="copy-validation-error"
                className="bg-destructive/10 text-destructive rounded-md p-3 text-sm"
                role="alert"
              >
                {copy.validationError.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeCopy} disabled={copyMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleCopy} disabled={copyMutation.isPending}>
              {copyMutation.isPending ? 'Copying...' : 'Copy Custom LLM'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
