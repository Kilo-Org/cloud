import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { AgentPermissionsPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AgentPermissionFields } from './AgentPermissionFields';
import {
  parsePermissionPolicyDocument,
  reviewPermissionPolicyImport,
  validateAgentPermissionPolicy,
} from './permission-policy-import';
import {
  agentPermissionSummary,
  allOsPermissions,
  PermissionPolicyEditorActions,
  permissionSetLabels,
  permissionSetOptions,
  policyJson,
  PolicySelect,
  shellOptions,
  type AgentDraft,
  type AgentPermissionSource,
  type PermissionSetSelection,
  type PolicyDraft,
  type ShellKind,
  type ShellProfile,
} from './permission-policy-ui';

type JsonEditor = { mode: 'advanced' | 'import'; source: string };

export function PermissionPolicyEditor({
  initial,
  inherited,
  isGroup,
  canEdit,
  isSaving,
  isRemoving,
  onSave,
  onRemove,
  onClose,
}: {
  initial: AgentPermissionsPolicy;
  inherited?: AgentPermissionsPolicy;
  isGroup: boolean;
  canEdit: boolean;
  isSaving: boolean;
  isRemoving: boolean;
  onSave: (policy: AgentPermissionsPolicy) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [edited, setEdited] = useState<PolicyDraft | null>(null);
  const [permissionSet, setPermissionSet] = useState<PermissionSetSelection>('all');
  const [jsonEditor, setJsonEditor] = useState<JsonEditor | null>(null);
  const draft = edited ?? initial;
  const allOs = allOsPermissions(draft.data);
  const selected = permissionSet === 'all' ? allOs : draft.data.by_os?.[permissionSet];
  const setLabel = permissionSetLabels[permissionSet];
  const sources: AgentPermissionSource[] = [];
  if (inherited) {
    sources.push({
      name: permissionSet === 'all' ? 'Organization default' : 'Organization default (All OS)',
      permissions: allOsPermissions(inherited.data),
    });
  }
  if (permissionSet !== 'all') {
    sources.push({ name: isGroup ? 'Group All OS' : 'All OS baseline', permissions: allOs });
    const matchingDefault = inherited?.data.by_os?.[permissionSet];
    if (matchingDefault) {
      sources.push({ name: `Organization default (${setLabel})`, permissions: matchingDefault });
    }
  }

  const validated = validateAgentPermissionPolicy(draft);
  const busy = isSaving || isRemoving;
  const canSave =
    canEdit &&
    !jsonEditor &&
    !busy &&
    edited !== null &&
    validated.status === 'valid' &&
    policyJson(validated.policy) !== policyJson(initial);

  function updatePermissionSet(permissions: AgentDraft | undefined) {
    if (permissionSet === 'all') {
      setEdited({
        ...draft,
        data: { schema_version: 1, ...permissions, by_os: draft.data.by_os },
      });
      return;
    }
    const by_os = { ...draft.data.by_os };
    if (permissions) by_os[permissionSet] = permissions;
    else delete by_os[permissionSet];
    setEdited({
      ...draft,
      data: { ...draft.data, by_os: Object.keys(by_os).length ? by_os : undefined },
    });
  }

  function exportPolicy() {
    if (validated.status !== 'valid') return;
    const url = URL.createObjectURL(
      new Blob([`${policyJson(validated.policy)}\n`], { type: 'application/json' })
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
        <PolicySelect
          label="Permission set"
          value={permissionSet}
          options={permissionSetOptions}
          disabled={busy || jsonEditor !== null}
          description={
            permissionSet === 'all'
              ? 'The All OS set applies to every execution OS. OS-specific sets can add restrictions, never relax them.'
              : `This set adds restrictions for ${setLabel}. The All OS rules and any applicable organization restrictions still apply.`
          }
          onChange={setPermissionSet}
        />
        {permissionSet !== 'all' && (
          <div className="grid gap-2 rounded-md border p-3">
            <p className="type-label font-medium">Inherited permission sets</p>
            <dl className="type-label grid gap-2">
              {sources.map(source => (
                <div key={source.name}>
                  <dt className="font-medium">{source.name}</dt>
                  <dd className="text-muted-foreground">
                    {agentPermissionSummary(source.permissions)}
                  </dd>
                </div>
              ))}
            </dl>
            {!selected && (
              <p className="type-label text-muted-foreground">
                No {setLabel} permissions added at this scope.
              </p>
            )}
            {canEdit && (
              <Button
                className="w-fit"
                variant={selected ? 'ghost' : 'outline'}
                size="sm"
                disabled={busy || jsonEditor !== null}
                onClick={() => updatePermissionSet(selected ? undefined : {})}
              >
                {selected ? 'Remove' : 'Add'} {setLabel} permissions
              </Button>
            )}
          </div>
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
            disabled={validated.status !== 'valid' || jsonEditor !== null}
            onClick={exportPolicy}
          >
            Export JSON
          </Button>
        </div>
        {jsonEditor ? (
          <PolicyJsonEditor
            key={jsonEditor.mode}
            editor={jsonEditor}
            setLabel={setLabel}
            onClose={() => setJsonEditor(null)}
            onApply={(policy, source) => {
              if (source === 'local') {
                updatePermissionSet({
                  ...selected,
                  tools: policy.data.tools,
                  shell: policy.data.shell,
                });
              } else {
                setEdited(policy);
                if (permissionSet !== 'all' && !policy.data.by_os?.[permissionSet]) {
                  setPermissionSet('all');
                }
              }
              setJsonEditor(null);
              toast.success('Draft updated. Save policy to apply it.');
            }}
          />
        ) : selected ? (
          <AgentPermissionFields
            draft={selected}
            sources={sources}
            disabled={!canEdit || busy}
            onChange={updatePermissionSet}
          />
        ) : null}
        {!jsonEditor && canEdit && validated.status === 'invalid' && (
          <div className="type-label text-status-destructive grid gap-1" role="status">
            {validated.errors.slice(0, 5).map(error => (
              <p key={error}>{error.replace(/^data\./, '')}</p>
            ))}
          </div>
        )}
      </div>
      <PermissionPolicyEditorActions
        canEdit={canEdit}
        isSaving={isSaving}
        isDeleting={isRemoving}
        canSave={canSave}
        onCancel={onClose}
        onDelete={
          jsonEditor || isSaving || !onRemove
            ? undefined
            : async () => {
                if (await onRemove()) {
                  setEdited(null);
                  setPermissionSet('all');
                }
              }
        }
        onSave={async () => {
          if (canSave && validated.status === 'valid' && (await onSave(validated.policy))) {
            setEdited(null);
          }
        }}
      />
    </div>
  );
}

function PolicyJsonEditor({
  editor,
  setLabel,
  onApply,
  onClose,
}: {
  editor: JsonEditor;
  setLabel: string;
  onApply: (policy: AgentPermissionsPolicy, source: 'local' | 'native') => void;
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
            : 'Edit the whole versioned agent permissions document, including all OS sets. Reviewing JSON does not save it.'}
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
          <p className="type-label text-muted-foreground">
            {interpreted.source === 'local'
              ? `Replaces tool permissions and shell profiles in ${setLabel} only. Other sets and managed mode restrictions stay unchanged.`
              : 'Replaces the whole agent permissions draft, including all OS sets.'}
          </p>
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
              if (interpreted.status === 'valid') onApply(interpreted.policy, interpreted.source);
            }}
          >
            Use in editor
          </Button>
        </div>
      )}
    </section>
  );
}
