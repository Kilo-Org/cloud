'use client';

import { useCallback, useState, type ReactNode } from 'react';
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
import { ChevronRight, Copy as CopyIcon, Globe, Lock, Plus, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import Editor, { type EditorProps } from '@monaco-editor/react';

const StrictCustomLlmDefinitionSchema = deepStrict(CustomLlmDefinitionSchema);
const StrictCustomLlmCredentialsSchema = deepStrict(CustomLlmCredentialsSchema);

const JSON_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: 'on',
  scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false },
  automaticLayout: true,
  tabSize: 2,
  formatOnPaste: true,
} satisfies EditorProps['options'];

const CREDENTIAL_FORMATS: { title: string; description: ReactNode; example: string }[] = [
  {
    title: 'API key',
    description: (
      <>
        Use <code className="text-foreground">&quot;type&quot;: &quot;x-api-key&quot;</code> instead
        when the provider expects an <code className="text-foreground">x-api-key</code> header.
      </>
    ),
    example: `{
  "type": "api_key",
  "api_key": "YOUR_API_KEY"
}`,
  },
  {
    title: 'Secure proxy',
    description: (
      <>
        Set the definition&apos;s <code className="text-foreground">base_url</code> to the
        proxy&apos;s <code className="text-foreground">/api/proxy</code> URL.
      </>
    ),
    example: `{
  "type": "secure_proxy",
  "proxy_secret": "KILO_AI_GATEWAY_SECURE_PROXY_SECRET value",
  "config": {
    "url": "https://upstream.example.com/v1",
    "extra_headers": { "Authorization": "Bearer YOUR_API_KEY" }
  }
}`,
  },
  {
    title: 'Google Cloud service account',
    description: <>Paste the service account key JSON and add the type.</>,
    example: `{
  "type": "service_account",
  "project_id": "my-project",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n...",
  "client_email": "...",
  ...
}`,
  },
  {
    title: 'Amazon Bedrock IAM access keys',
    description: (
      <>
        Set the definition&apos;s <code className="text-foreground">base_url</code> to a Bedrock
        endpoint such as{' '}
        <code className="text-foreground break-all">
          https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
        </code>
        . Requests are signed with AWS SigV4. For a Bedrock API key, use an API key credential
        instead.
      </>
    ),
    example: `{
  "type": "aws_bedrock",
  "region": "us-east-1",
  "access_key_id": "AKIA...",
  "secret_access_key": "YOUR_SECRET_ACCESS_KEY"
}`,
  },
];

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  publicId: string;
  wasPublic: boolean;
  wasPriced: boolean;
  credentialsJson: string;
  definitionJson: string;
  validationError: string | null;
};

type CopyState = {
  sourcePublicId: string;
  sourceIsPublic: boolean;
  sourceIsPriced: boolean;
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

/** A save that makes a custom LLM public, or starts charging for a public one, which needs confirmation. */
type PendingChange = { priced: boolean; alreadyPublic: boolean } & (
  | { kind: 'upsert'; input: UpsertInput }
  | { kind: 'copy'; input: CopyInput }
);

const initialEditorState: EditorState = {
  open: false,
  mode: 'create',
  publicId: '',
  wasPublic: false,
  wasPriced: false,
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
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);

  const openCreate = useCallback(() => {
    setEditor({
      open: true,
      mode: 'create',
      publicId: '',
      wasPublic: false,
      wasPriced: false,
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
      wasPriced: definition.pricing !== undefined,
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
      sourceIsPriced: source.pricing !== undefined,
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
              validationError: { field: 'publicId', message: formatZodError(publicIdResult.error) },
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
      setPendingChange({ kind: 'copy', input, priced: copy.sourceIsPriced, alreadyPublic: false });
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
    const priced = input.definition.pricing !== undefined;
    const startsCharging = editor.wasPublic && priced && !editor.wasPriced;
    if (input.definition.public !== undefined && (!editor.wasPublic || startsCharging)) {
      setPendingChange({ kind: 'upsert', input, priced, alreadyPublic: editor.wasPublic });
      return;
    }
    await submitUpsert(input);
  }, [editor, submitUpsert]);

  const confirmPendingChange = useCallback(async () => {
    const change = pendingChange;
    setPendingChange(null);
    if (change?.kind === 'upsert') await submitUpsert(change.input);
    if (change?.kind === 'copy') await submitCopy(change.input);
  }, [pendingChange, submitUpsert, submitCopy]);

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
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Models served directly from an upstream with Kilo-managed, encrypted credentials.
        </p>
        <Button onClick={openCreate} size="sm">
          <Plus />
          Add Custom LLM
        </Button>
      </div>

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
                <TableCell>
                  {item.definition.public ? (
                    <Badge variant="new">
                      <Globe />
                      Public
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      <Lock />
                      Private
                    </Badge>
                  )}
                </TableCell>
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
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>
              {editor.mode === 'create' ? 'Add Custom LLM' : `Edit: ${editor.publicId}`}
            </DialogTitle>
          </DialogHeader>

          <div className="-mx-6 flex min-h-0 flex-col gap-4 overflow-y-auto px-6">
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
                  options={{ ...JSON_EDITOR_OPTIONS, ariaLabel: 'Custom LLM credentials JSON' }}
                />
              </div>
              <details className="group mt-2 text-xs">
                <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm select-none focus-visible:ring-[3px] focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-3.5 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  Credential formats
                </summary>
                <div className="bg-muted text-muted-foreground mt-2 flex flex-col gap-3 rounded-md p-3">
                  {CREDENTIAL_FORMATS.map(format => (
                    <section key={format.title} className="flex flex-col gap-1">
                      <h3 className="text-foreground font-medium">{format.title}</h3>
                      <p>{format.description}</p>
                      <pre className="text-foreground overflow-x-auto font-mono">
                        {format.example}
                      </pre>
                    </section>
                  ))}
                </div>
              </details>
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
                  options={{ ...JSON_EDITOR_OPTIONS, ariaLabel: 'Custom LLM definition JSON' }}
                />
              </div>
              <details className="group mt-2 text-xs">
                <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm select-none focus-visible:ring-[3px] focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-3.5 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  Definition rules
                </summary>
                <ul className="bg-muted text-muted-foreground mt-2 flex list-disc flex-col gap-1.5 rounded-md p-3 pl-7">
                  <li>
                    Public IDs use lowercase letters, digits, and <code>. / -</code>, and must not
                    start with <code>kilo/</code>, <code>kilo-auto/</code>, <code>kilocode/</code>,
                    or a direct BYOK provider prefix, or be an OpenRouter model.
                  </li>
                  <li>
                    <code>internal_id</code> is sent upstream as <code>model</code>; without it,{' '}
                    <code>model</code> is removed from the request body.{' '}
                    <code>disable_url_suffix</code> uses <code>base_url</code> without suffixes such
                    as <code>/messages</code>.
                  </li>
                  <li>
                    <code>api_kinds</code> lists the served APIs (<code>chat_completions</code>,{' '}
                    <code>messages</code>, <code>responses</code>). It must include the one{' '}
                    <code>opencode_settings.ai_sdk_provider</code> picks: Messages for{' '}
                    <code>anthropic</code>, Responses for <code>openai</code>, otherwise Chat
                    Completions, which is also the only API served without it.
                  </li>
                  <li>
                    IDs ending in <code>-free</code> or starting with <code>stealth/</code> are free
                    and must not set <code>pricing</code>; public free models work signed out. Other
                    models need <code>pricing</code> tiers in the custom pricing format, or users
                    are billed only what the upstream reports.
                  </li>
                  <li>
                    With <code>pricing</code>, set{' '}
                    <code>&quot;may_train_on_prompts&quot;: false</code> only for zero data
                    retention upstreams.
                  </li>
                  <li>
                    Grant access with <code>organization_ids</code> or <code>group_ids</code>, or
                    replace them with{' '}
                    <code>
                      &quot;public&quot;: {'{'} &quot;inference_providers&quot;: [&quot;acme&quot;],
                      &quot;description&quot;: &quot;…&quot; {'}'}
                    </code>{' '}
                    to offer it to everyone, subject to organization provider allow lists. Without
                    any of these, nobody can use the model.
                  </li>
                  <li>
                    Routing picks up changes within about a minute; public models and new providers
                    appear in the model list after the next provider sync.
                  </li>
                </ul>
              </details>
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
        open={pendingChange !== null}
        onOpenChange={open => {
          if (!open) setPendingChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingChange?.alreadyPublic
                ? 'Start charging for this public custom LLM?'
                : 'Make this custom LLM public?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                {pendingChange?.alreadyPublic ? (
                  <p>
                    Signed-in Kilo users will be billed for{' '}
                    <code className="font-mono">{pendingChange.input.public_id}</code> at the
                    definition&apos;s pricing.
                  </p>
                ) : pendingChange?.priced ? (
                  <p>
                    Every signed-in Kilo user will be able to use{' '}
                    <code className="font-mono">{pendingChange.input.public_id}</code> at the
                    definition&apos;s pricing.
                  </p>
                ) : (
                  <p>
                    Every Kilo user will be able to use{' '}
                    <code className="font-mono">{pendingChange?.input.public_id}</code> without
                    being charged. Kilo pays for all usage. Unless the public ID ends in{' '}
                    <code>-free</code> or starts with <code>stealth/</code>, only signed-in users
                    with credits can use it.
                  </p>
                )}
                <p>
                  Test this definition with a local web app before saving it. A broken definition
                  fails requests for everyone who can use it.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPendingChange}>
              {pendingChange?.alreadyPublic ? 'Start charging' : 'Make public'}
            </AlertDialogAction>
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
