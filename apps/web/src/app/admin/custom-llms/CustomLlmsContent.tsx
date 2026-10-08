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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useCustomLlms,
  useCopyCustomLlm,
  useUpsertCustomLlm,
  useDeleteCustomLlm,
} from '@/app/admin/api/custom-llms/hooks';
import {
  CustomLlmCredentialsSchema,
  CustomLlmDefinitionSchema,
  CustomLlmPublicIdSchema,
} from '@kilocode/db/schema-types';
import type { CustomLlmCredentials, CustomLlmDefinition } from '@kilocode/db/schema-types';
import { deepStrict } from '@/lib/zod/deep-strict';
import { formatZodError } from '@/lib/zod/format-zod-error';
import { toast } from 'sonner';
import { Copy as CopyIcon, Plus, Pencil } from 'lucide-react';
import Editor from '@monaco-editor/react';

const StrictCustomLlmDefinitionSchema = deepStrict(CustomLlmDefinitionSchema);
const StrictCustomLlmCredentialsSchema = deepStrict(CustomLlmCredentialsSchema);

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  publicId: string;
  wasPublic: boolean;
  credentialsJson: string;
  definitionJson: string;
  validationError: string | null;
};

type CopyState = {
  sourcePublicId: string;
  sourceIsPublic: boolean;
  publicId: string;
  displayName: string;
  internalId: string;
  validationError: {
    field: 'publicId' | 'displayName' | null;
    message: string;
  } | null;
};

const INITIAL_DEFINITION: CustomLlmDefinition = {
  display_name: '',
  context_length: 0,
  max_completion_tokens: 0,
  base_url: '',
  disable_url_suffix: false,
  organization_ids: [],
  group_ids: [],
};

const INITIAL_CREDENTIALS: CustomLlmCredentials = {
  type: 'api_key',
  api_key: '',
};

type UpsertInput = {
  public_id: string;
  definition: CustomLlmDefinition;
  credentials: CustomLlmCredentials | undefined;
};

type CopyInput = {
  source_public_id: string;
  public_id: string;
  display_name: string;
  internal_id: string | undefined;
};

type PendingPublicChange =
  | { kind: 'upsert'; input: UpsertInput }
  | { kind: 'copy'; input: CopyInput };

const initialEditorState: EditorState = {
  open: false,
  mode: 'create',
  publicId: '',
  wasPublic: false,
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
  const [pendingPublicChange, setPendingPublicChange] = useState<PendingPublicChange | null>(null);

  const openCreate = useCallback(() => {
    setEditor({
      open: true,
      mode: 'create',
      publicId: '',
      wasPublic: false,
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
      wasPublic: definition.public !== undefined,
      credentialsJson: '',
      definitionJson: JSON.stringify(definition, null, 2),
      validationError: null,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(initialEditorState);
  }, []);

  const openCopy = useCallback((sourcePublicId: string, source: CustomLlmDefinition) => {
    setCopy({
      sourcePublicId,
      sourceIsPublic: source.public !== undefined,
      publicId: sourcePublicId,
      displayName: source.display_name,
      internalId: source.internal_id ?? '',
      validationError: null,
    });
  }, []);

  const closeCopy = useCallback(() => {
    setCopy(null);
  }, []);

  const submitCopy = useCallback(
    async (input: CopyInput) => {
      try {
        await copyMutation.mutateAsync(input);
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
    },
    [copyMutation, closeCopy]
  );

  const submitUpsert = useCallback(
    async (input: UpsertInput) => {
      try {
        await upsertMutation.mutateAsync(input);
        toast.success(editor.mode === 'create' ? 'Custom LLM created' : 'Custom LLM updated');
        closeEditor();
      } catch (error) {
        toast.error(formatZodError(error));
      }
    },
    [editor.mode, upsertMutation, closeEditor]
  );

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

    const publicIdResult = CustomLlmPublicIdSchema.safeParse(publicId);
    if (!publicIdResult.success) {
      setCopy(prev =>
        prev
          ? {
              ...prev,
              validationError: {
                field: 'publicId',
                message: formatZodError(publicIdResult.error),
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

    const input: CopyInput = {
      source_public_id: copy.sourcePublicId,
      public_id: publicId,
      display_name: displayName,
      internal_id: internalId || undefined,
    };
    if (copy.sourceIsPublic) {
      setPendingPublicChange({ kind: 'copy', input });
      return;
    }
    await submitCopy(input);
  }, [copy, submitCopy]);

  const handleSave = useCallback(async () => {
    const trimmedPublicId = editor.publicId.trim();
    if (!trimmedPublicId) {
      setEditor(prev => ({ ...prev, validationError: 'public_id is required' }));
      return;
    }

    if (editor.mode === 'create') {
      const publicIdResult = CustomLlmPublicIdSchema.safeParse(trimmedPublicId);
      if (!publicIdResult.success) {
        setEditor(prev => ({ ...prev, validationError: formatZodError(publicIdResult.error) }));
        return;
      }
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

    // The strict copy rejects unknown keys but drops cross-field rules, so check both.
    const strictDefResult = StrictCustomLlmDefinitionSchema.safeParse(parsedDefinition);
    const defResult = strictDefResult.success
      ? CustomLlmDefinitionSchema.safeParse(parsedDefinition)
      : strictDefResult;
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

    const input: UpsertInput = {
      public_id: trimmedPublicId,
      definition: defResult.data,
      credentials: parsedCredentials,
    };
    if (input.definition.public !== undefined && !editor.wasPublic) {
      setPendingPublicChange({ kind: 'upsert', input });
      return;
    }
    await submitUpsert(input);
  }, [editor, submitUpsert]);

  const confirmPublicChange = useCallback(async () => {
    const change = pendingPublicChange;
    setPendingPublicChange(null);
    if (change?.kind === 'upsert') await submitUpsert(change.input);
    if (change?.kind === 'copy') await submitCopy(change.input);
  }, [pendingPublicChange, submitUpsert, submitCopy]);

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
              <TableHead>Access</TableHead>
              <TableHead>Internal ID</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No custom LLMs defined yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(item => (
              <TableRow key={item.public_id}>
                <TableCell className="font-mono text-sm">{item.public_id}</TableCell>
                <TableCell>{item.definition.display_name}</TableCell>
                <TableCell>{item.definition.public ? 'Public' : 'Private'}</TableCell>
                <TableCell className="font-mono text-sm">
                  {item.definition.internal_id ?? 'Not set'}
                </TableCell>
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
                      onClick={() => openCopy(item.public_id, item.definition)}
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
                placeholder="e.g. acme/my-custom-model"
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
                    ariaLabel: 'Custom LLM definition JSON',
                  }}
                />
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Set <code>disable_url_suffix</code> to <code>true</code> to use{' '}
                <code>base_url</code> exactly, without suffixes such as <code>/messages</code>. Add{' '}
                <code>&quot;internal_id&quot;: &quot;provider-model&quot;</code> to send an upstream{' '}
                <code>model</code>; omit <code>internal_id</code> to remove <code>model</code> from
                the outbound request body.
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Public ID may only contain lowercase letters, digits, and <code>. / -</code>. It
                must not start with <code>kilo/</code>, <code>kilo-auto/</code>, or{' '}
                <code>kilocode/</code>, be an OpenRouter model, or use a direct BYOK provider
                prefix. It may reuse a Kilo-exclusive model ID, which the custom LLM then replaces.
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                To make the model available to every user for free, replace{' '}
                <code>organization_ids</code> and <code>group_ids</code> with{' '}
                <code>
                  &quot;public&quot;: {'{'} &quot;inference_providers&quot;: [&quot;acme&quot;]{' '}
                  {'}'}
                </code>
                , add a <code>description</code>, and remove <code>pricing</code>. Organization
                provider allow lists apply to these providers. Unknown providers appear in the
                provider list after the next provider sync.
              </p>
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

      <AlertDialog
        open={pendingPublicChange !== null}
        onOpenChange={open => {
          if (!open) setPendingPublicChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this custom LLM public?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>
                  Every Kilo user, including signed-out users, will be able to use{' '}
                  <code className="font-mono">{pendingPublicChange?.input.public_id}</code> for
                  free. Kilo pays for all usage.
                </p>
                <p>
                  Test this definition with a local web app before publishing it. A broken
                  definition fails requests for everyone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPublicChange}>Make public</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                placeholder="e.g. acme/my-copied-model"
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
              <Label htmlFor="copy-internal-id">New Internal ID (optional)</Label>
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
                aria-describedby="copy-internal-id-help"
              />
              <p id="copy-internal-id-help" className="text-muted-foreground mt-1 text-xs">
                Leave blank to omit <code>model</code> from the outbound request body instead of
                keeping the source internal ID.
              </p>
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
