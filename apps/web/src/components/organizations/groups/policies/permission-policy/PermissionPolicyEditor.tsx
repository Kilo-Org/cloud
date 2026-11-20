import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  OrganizationPermissionPolicySchema,
  type OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PolicyEditorFooter } from '../PolicyEditorFooter';
import { AgentPermissionFields } from './AgentPermissionFields';
import {
  parsePermissionPolicyDocument,
  reviewPermissionPolicyImport,
} from './permission-policy-import';
import {
  policyJson,
  PolicySelect,
  shellOptions,
  type PolicyDraft,
  type ShellKind,
  type ShellProfile,
} from './permission-policy-ui';

type JsonEditor = { mode: 'advanced' | 'import'; source: string };

export function PermissionPolicyEditor({
  initial,
  inherited,
  canEdit,
  lockReason,
  isSaving,
  isRemoving,
  onSave,
  onRemove,
  onClose,
}: {
  initial: OrganizationPermissionPolicy;
  inherited?: OrganizationPermissionPolicy;
  canEdit: boolean;
  lockReason: string;
  isSaving: boolean;
  isRemoving: boolean;
  onSave: (policy: OrganizationPermissionPolicy) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [edited, setEdited] = useState<PolicyDraft | null>(null);
  const draft = edited ?? initial;
  const [jsonEditor, setJsonEditor] = useState<JsonEditor | null>(null);
  const validated = OrganizationPermissionPolicySchema.safeParse(draft);
  const busy = isSaving || isRemoving;
  const canSave =
    canEdit &&
    !jsonEditor &&
    !busy &&
    edited !== null &&
    validated.success &&
    policyJson(validated.data) !== policyJson(initial);

  function exportPolicy() {
    if (!validated.success) return;
    const url = URL.createObjectURL(
      new Blob([`${policyJson(validated.data)}\n`], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${draft.type}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-4 p-5">
        {!canEdit && (
          <p className="type-body text-muted-foreground rounded-md border px-3 py-2">
            {lockReason}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || jsonEditor !== null}
                onClick={() => setJsonEditor({ mode: 'import', source: '' })}
              >
                Import JSON/JSONC
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || jsonEditor !== null}
                onClick={() => setJsonEditor({ mode: 'advanced', source: policyJson(draft) })}
              >
                Edit JSON
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!validated.success || jsonEditor !== null}
            onClick={exportPolicy}
          >
            Export JSON
          </Button>
        </div>
        {jsonEditor ? (
          <PolicyJsonEditor
            key={jsonEditor.mode}
            editor={jsonEditor}
            onClose={() => setJsonEditor(null)}
            onApply={policy => {
              setEdited(policy);
              setJsonEditor(null);
              toast.success('Draft updated. Save policy to apply it.');
            }}
          />
        ) : (
          <AgentPermissionFields
            draft={draft.data}
            inherited={inherited?.data}
            disabled={!canEdit || busy}
            onChange={data => setEdited({ type: 'agent_permissions', data })}
          />
        )}
        {!jsonEditor && canEdit && !validated.success && (
          <div className="type-label text-status-destructive grid gap-1" role="status">
            {validated.error.issues.slice(0, 5).map((issue, index) => {
              const path = issue.path.slice(1).map(String).join('.') || 'Policy';
              const message =
                issue.path.at(-1) === 'fallback'
                  ? 'Choose an explicit fallback for unlisted shell commands.'
                  : issue.message;
              return (
                <p key={index}>
                  {path}: {message}
                </p>
              );
            })}
          </div>
        )}
      </div>
      {canEdit ? (
        <PolicyEditorFooter
          isSaving={isSaving}
          isDeleting={isRemoving}
          canSave={canSave}
          onCancel={onClose}
          onDelete={
            jsonEditor || isSaving || !onRemove
              ? undefined
              : async () => {
                  if (await onRemove()) setEdited(null);
                }
          }
          onSave={async () => {
            if (canSave && validated.success && (await onSave(validated.data))) setEdited(null);
          }}
        />
      ) : (
        <div className="sticky bottom-0 flex justify-end border-t bg-surface-raised px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

function PolicyJsonEditor({
  editor,
  onApply,
  onClose,
}: {
  editor: JsonEditor;
  onApply: (policy: OrganizationPermissionPolicy) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(editor.source);
  const [reviewed, setReviewed] = useState(false);
  const [shell, setShell] = useState<ShellKind | ''>('');
  const [fallback, setFallback] = useState<ShellProfile['fallback'] | ''>('');
  const isImport = editor.mode === 'import';
  const preview = reviewed
    ? isImport
      ? reviewPermissionPolicyImport(text)
      : parsePermissionPolicyDocument(text)
    : null;
  const interpreted =
    preview?.status === 'needs-shell' && shell && fallback
      ? reviewPermissionPolicyImport(text, { kind: shell, fallback })
      : preview;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border p-4">
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{isImport ? 'Configuration JSON or JSONC' : 'Policy JSON'}</Label>
        <Textarea
          id={id}
          spellCheck={false}
          rows={isImport ? 8 : 12}
          className="font-mono"
          value={text}
          onChange={event => {
            setText(event.target.value);
            setReviewed(false);
            setShell('');
            setFallback('');
          }}
        />
        <p className="type-label text-muted-foreground">
          {isImport
            ? 'Paste a versioned policy or the contents of kilo.json or kilo.jsonc. Only supported permission settings are imported. Do not paste credentials.'
            : 'Edit the versioned agent permissions document. Reviewing JSON does not save it.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setReviewed(true)} disabled={!text.trim()}>
          {isImport ? 'Preview import' : 'Validate JSON'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {isImport ? 'Cancel import' : 'Cancel JSON editing'}
        </Button>
      </div>
      {preview?.status === 'needs-shell' && (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="type-label text-muted-foreground">
            Local command rules do not specify a shell or a managed fallback. Choose both. A
            declared shell policy blocks shell kinds without a profile. A catch-all rule remains a
            rule, not a fallback.
          </p>
          <PolicySelect
            label="Shell for imported commands"
            value={shell}
            options={[
              { value: '', label: 'Choose a shell', disabled: true },
              { value: 'bash', label: 'Bash' },
              { value: 'powershell', label: 'PowerShell' },
            ]}
            onChange={setShell}
          />
          <PolicySelect
            label="Unlisted commands for imported shell"
            value={fallback}
            options={[{ value: '', label: 'Choose a fallback', disabled: true }, ...shellOptions]}
            onChange={setFallback}
          />
        </div>
      )}
      {interpreted?.status === 'invalid' && (
        <ul role="alert" className="type-label text-status-destructive list-disc space-y-1 pl-4">
          {interpreted.errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
      {interpreted && interpreted.status !== 'invalid' && (
        <div
          className="grid grid-cols-[minmax(0,1fr)] gap-3 border-t pt-3"
          role="region"
          aria-label="Policy preview"
        >
          <h3 className="type-body font-medium">
            {interpreted.status === 'valid'
              ? 'Validated policy preview'
              : 'Incomplete policy preview'}
          </h3>
          {interpreted.warnings.length > 0 && (
            <ul className="type-label text-muted-foreground list-disc space-y-1 break-words pl-4">
              {interpreted.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <pre className="type-label bg-background max-h-64 overflow-auto rounded-md border p-3">
            {policyJson(interpreted.policy)}
          </pre>
          {interpreted.status === 'needs-shell' && (
            <pre
              className="type-label bg-background max-h-40 overflow-auto rounded-md border p-3"
              aria-label="Imported command rules"
            >
              {JSON.stringify(interpreted.rules, null, 2)}
            </pre>
          )}
          <Button
            className="w-fit"
            variant="outline"
            disabled={interpreted.status !== 'valid'}
            onClick={() => {
              if (interpreted.status === 'valid') onApply(interpreted.policy);
            }}
          >
            Use in editor
          </Button>
        </div>
      )}
    </section>
  );
}
