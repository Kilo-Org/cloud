'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { NetworkSecretsEditor } from '@/components/cloud-agent-next/NetworkSecretsEditor';
import {
  buildNetworkSecretChanges,
  draftAfterFailedSave,
  emptyNetworkSecretForm,
  hasPendingNetworkSecret,
  networkSecretSaveFailureMessage,
  saveNetworkSecretChanges,
  type NetworkSecretDraft,
} from '@/components/cloud-agent-next/network-secrets-form';
import type {
  ProfileVar,
  useProfileMutations,
  useCombinedProfileMutations,
} from '@/hooks/useCloudAgentProfiles';

type ProfileMutations =
  | ReturnType<typeof useProfileMutations>
  | ReturnType<typeof useCombinedProfileMutations>;

type NetworkSecretMutations = {
  [Key in 'deleteVar' | 'setVar']: Pick<ProfileMutations[Key], 'mutateAsync'>;
};

export function ProfileNetworkSecrets({
  profileId,
  organizationId,
  vars,
  mutations,
  readOnly,
}: {
  profileId: string;
  organizationId?: string;
  vars: ProfileVar[];
  mutations: NetworkSecretMutations;
  readOnly: boolean;
}) {
  const saved: NetworkSecretDraft[] = vars
    .filter(row => row.delivery === 'network')
    .map(row => ({ key: row.key, allowedHosts: row.allowedHosts ?? [], locations: ['header'] }));
  const [draft, setDraft] = useState<{
    baseline: NetworkSecretDraft[];
    rows: NetworkSecretDraft[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyNetworkSecretForm);
  const changes = draft ? buildNetworkSecretChanges(draft.baseline, draft.rows) : [];
  const save = async () => {
    setSaving(true);
    try {
      const failures = await saveNetworkSecretChanges(changes, change =>
        'delete' in change
          ? mutations.deleteVar.mutateAsync({ profileId, organizationId, key: change.key })
          : mutations.setVar.mutateAsync({
              profileId,
              organizationId,
              key: change.key,
              value: change.value,
              isSecret: true,
              networkSecret: { allowedHosts: change.allowedHosts, locations: change.locations },
            })
      );
      if (failures.length === 0) {
        setDraft(null);
        toast.success('Network secrets saved');
      } else {
        const failedKeys = new Set(failures.map(failure => failure.key));
        const deletedKeys = new Set(
          changes.flatMap(change =>
            'delete' in change && !failedKeys.has(change.key) ? [change.key] : []
          )
        );
        setDraft(
          current =>
            current && {
              baseline: current.baseline.filter(row => !deletedKeys.has(row.key)),
              rows: draftAfterFailedSave(current.rows, failures),
            }
        );
        toast.error(networkSecretSaveFailureMessage(failures, changes.length));
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset disabled={saving} className="space-y-3 border-t pt-4">
      <h3 className="text-xs font-medium">Network secrets</h3>
      <NetworkSecretsEditor
        source="profile"
        value={draft?.rows ?? saved}
        onChange={rows => setDraft(current => ({ baseline: current?.baseline ?? saved, rows }))}
        form={form}
        onFormChange={setForm}
        readOnly={readOnly}
      />
      {!readOnly && changes.length > 0 && (
        <Button
          type="button"
          size="sm"
          disabled={saving || hasPendingNetworkSecret(form)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save network secrets'}
        </Button>
      )}
    </fieldset>
  );
}
