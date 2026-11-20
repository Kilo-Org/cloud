import { useId, useState } from 'react';
import type { ClientConfigurationPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PermissionPolicyEditorActions } from './permission-policy-ui';

export function ClientConfigurationEditor({
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
  initial?: ClientConfigurationPolicy;
  inherited?: ClientConfigurationPolicy;
  isGroup: boolean;
  canEdit: boolean;
  isSaving: boolean;
  isRemoving: boolean;
  onSave: (policy: ClientConfigurationPolicy) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  onClose: () => void;
}) {
  const id = useId();
  const [edited, setEdited] = useState<boolean>();
  const saved = initial?.data.show_session_dollar_values;
  const hiddenByDefault = inherited?.data.show_session_dollar_values === false;
  const visible = !hiddenByDefault && (edited ?? saved ?? true);
  const disabled = !canEdit || isSaving || isRemoving || hiddenByDefault;
  const canSave = !disabled && edited !== undefined && edited !== saved;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-4 px-5 py-4">
        <p className="type-body text-muted-foreground">
          Set whether supported clients display dollar values in sessions. Hiding the values does
          not change billing.
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 rounded-md border p-3">
          <div className="grid gap-2">
            <Label htmlFor={id}>Show session dollar values</Label>
            <p id={`${id}-description`} className="type-label text-muted-foreground">
              {hiddenByDefault
                ? 'Hidden by the organization default. A group cannot make them visible.'
                : isGroup
                  ? 'Other applicable group policies can still hide the values for a member.'
                  : 'Dollar values are visible by default. A group can hide them for its members.'}
            </p>
          </div>
          <Switch
            id={id}
            aria-describedby={`${id}-description`}
            checked={visible}
            disabled={disabled}
            onCheckedChange={setEdited}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="type-label font-medium">Visibility at this scope</p>
          <Badge variant="outline">{visible ? 'Visible' : 'Hidden'}</Badge>
        </div>
        <p className="type-label text-muted-foreground">
          {saved === undefined
            ? 'No policy saved at this scope.'
            : `Saved at this scope: ${saved ? 'Visible' : 'Hidden'}.`}
          {isGroup &&
            inherited?.data.show_session_dollar_values === true &&
            ' The organization default is visible.'}
        </p>
      </div>
      <PermissionPolicyEditorActions
        canEdit={canEdit}
        isSaving={isSaving}
        isDeleting={isRemoving}
        canSave={canSave}
        onCancel={onClose}
        onDelete={
          isSaving || !onRemove
            ? undefined
            : async () => {
                if (await onRemove()) setEdited(undefined);
              }
        }
        onSave={async () => {
          if (
            canSave &&
            (await onSave({
              type: 'client_configuration',
              data: { schema_version: 1, show_session_dollar_values: edited },
            }))
          ) {
            setEdited(undefined);
          }
        }}
      />
    </div>
  );
}
