'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { Plus, Loader2, Eye, EyeOff, Lock, Trash2, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { cn } from '@/lib/utils';
import type {
  useProfileMutations,
  useCombinedProfileMutations,
  ProfileVar,
} from '@/hooks/useCloudAgentProfiles';

type VarsTabProps = {
  profileId: string;
  organizationId?: string;
  vars: ProfileVar[];
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
};

type DraftVar = { id: string; key: string; value: string; isSecret: boolean; showValue: boolean };

const makeDraft = (partial?: Partial<DraftVar>): DraftVar => ({
  id: uuidv4(),
  key: '',
  value: '',
  isSecret: false,
  showValue: false,
  ...partial,
});

const cleanKey = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

export function VarsTab({ profileId, organizationId, vars, mutations }: VarsTabProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [drafts, setDrafts] = useState<DraftVar[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [showEditValue, setShowEditValue] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const startAdding = () => {
    setIsAdding(true);
    setDrafts([makeDraft()]);
  };

  const resetAdd = () => {
    setIsAdding(false);
    setDrafts([]);
  };

  const updateDraft = (id: string, patch: Partial<DraftVar>) => {
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  };

  const removeDraft = (id: string) => {
    setDrafts(prev => {
      const next = prev.filter(d => d.id !== id);
      return next.length === 0 ? [makeDraft()] : next;
    });
  };

  /** Handle paste into a draft row. Returns true if handled (caller should preventDefault). */
  const handleDraftPaste = (id: string, text: string): boolean => {
    const parsed = parseEnvText(text);
    if (parsed.length === 0) return false;
    setDrafts(prev => {
      const idx = prev.findIndex(d => d.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      const targetIsEmpty = target.key === '' && target.value === '';
      const newRows = parsed.map(p =>
        makeDraft({ key: p.key, value: p.value, isSecret: target.isSecret })
      );
      // Replace the current row if it's empty; otherwise insert after it.
      const before = prev.slice(0, idx);
      const after = prev.slice(idx + 1);
      if (targetIsEmpty) {
        return [...before, ...newRows, ...after];
      }
      if (parsed.length === 1) {
        // Single pair pasted into a populated field — let the browser handle it (overwrite just that field).
        return prev;
      }
      return [...before, target, ...newRows, ...after];
    });
    return true;
  };

  const handleSaveAll = async () => {
    const entries = drafts.map(d => ({ ...d, key: d.key.trim() })).filter(d => d.key !== '');
    if (entries.length === 0) {
      toast.error('Add at least one variable');
      return;
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.key)) {
        toast.error(`Duplicate key "${e.key}" in drafts`);
        return;
      }
      seen.add(e.key);
    }
    setSavingKey('__new__');
    let succeeded = 0;
    const failed: string[] = [];
    try {
      for (const entry of entries) {
        try {
          await mutations.setVar.mutateAsync({
            profileId,
            key: entry.key,
            value: entry.value,
            isSecret: entry.isSecret,
            organizationId,
          });
          succeeded += 1;
        } catch {
          failed.push(entry.key);
        }
      }
      if (failed.length === 0) {
        toast.success(
          succeeded === 1 ? `Variable "${entries[0].key}" added` : `Added ${succeeded} variables`
        );
        resetAdd();
      } else {
        toast.error(
          `Added ${succeeded} of ${entries.length}. Failed: ${failed.slice(0, 3).join(', ')}${
            failed.length > 3 ? '…' : ''
          }`
        );
      }
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveEdit = async (varItem: ProfileVar) => {
    setSavingKey(varItem.key);
    try {
      await mutations.setVar.mutateAsync({
        profileId,
        key: varItem.key,
        value: editingValue,
        isSecret: varItem.isSecret,
        organizationId,
      });
      toast.success(`Variable "${varItem.key}" updated`);
      setEditingKey(null);
    } catch {
      toast.error('Failed to update variable');
    } finally {
      setSavingKey(null);
    }
  };

  const handleDelete = async (key: string) => {
    setDeletingKey(key);
    try {
      await mutations.deleteVar.mutateAsync({ profileId, key, organizationId });
      toast.success(`Variable "${key}" deleted`);
    } catch {
      toast.error('Failed to delete variable');
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-1.5">
        <Key className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-xs font-medium">Environment Variables</span>
      </div>

      {vars.map(varItem => (
        <div
          key={varItem.key}
          className="hover:bg-accent/50 rounded-lg border p-2 transition-colors"
        >
          {editingKey === varItem.key ? (
            <div className="space-y-2">
              <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs">{varItem.key}</code>
              <div className="relative">
                <Input
                  type={showEditValue ? 'text' : 'password'}
                  value={editingValue}
                  onChange={e => setEditingValue(e.target.value)}
                  placeholder={varItem.isSecret ? 'Enter new secret value' : 'Value'}
                  className="pr-10 text-sm"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-form-type="other"
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                  onClick={() => setShowEditValue(!showEditValue)}
                >
                  {showEditValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingKey(null)}
                  disabled={savingKey === varItem.key}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSaveEdit(varItem)}
                  disabled={savingKey === varItem.key}
                >
                  {savingKey === varItem.key ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <code className="bg-muted shrink-0 rounded px-2 py-0.5 font-mono text-xs">
                  {varItem.key}
                </code>
                {varItem.isSecret ? (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Lock className="h-3 w-3" />
                    •••••••
                  </span>
                ) : (
                  <span className="text-muted-foreground truncate text-xs">{varItem.value}</span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => {
                    setEditingKey(varItem.key);
                    setEditingValue(varItem.isSecret ? '' : varItem.value);
                    setShowEditValue(!varItem.isSecret);
                  }}
                  disabled={deletingKey === varItem.key}
                >
                  Edit
                </Button>
                <InlineDeleteConfirmation
                  onDelete={() => handleDelete(varItem.key)}
                  isLoading={deletingKey === varItem.key}
                />
              </div>
            </div>
          )}
        </div>
      ))}

      {isAdding ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Label className="text-xs">New variables</Label>
            <p className="text-muted-foreground text-[11px]">
              Tip: paste <code className="font-mono">KEY=VALUE</code> lines to add many at once.
            </p>
          </div>

          <div className="space-y-2">
            {drafts.map((draft, idx) => (
              <div
                key={draft.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 xl:grid-cols-[11rem_minmax(0,1fr)_auto_auto]"
              >
                <Input
                  aria-label="Variable name"
                  value={draft.key}
                  onChange={e => updateDraft(draft.id, { key: cleanKey(e.target.value) })}
                  onPaste={e => {
                    if (handleDraftPaste(draft.id, e.clipboardData.getData('text'))) {
                      e.preventDefault();
                    }
                  }}
                  placeholder="API_KEY"
                  className="col-span-3 h-8 w-full font-mono text-sm pointer-coarse:h-11 xl:col-span-1"
                  autoFocus={idx === 0}
                  disabled={savingKey === '__new__'}
                />
                <div className="relative min-w-0">
                  <Input
                    aria-label="Variable value"
                    type={draft.showValue || !draft.isSecret ? 'text' : 'password'}
                    value={draft.value}
                    onChange={e => updateDraft(draft.id, { value: e.target.value })}
                    onPaste={e => {
                      if (handleDraftPaste(draft.id, e.clipboardData.getData('text'))) {
                        e.preventDefault();
                      }
                    }}
                    placeholder={draft.isSecret ? 'Secret value (encrypted)' : 'Value'}
                    className="h-8 pr-8 text-sm pointer-coarse:h-11"
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-form-type="other"
                    disabled={savingKey === '__new__'}
                  />
                  {draft.isSecret && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                      onClick={() => updateDraft(draft.id, { showValue: !draft.showValue })}
                      tabIndex={-1}
                    >
                      {draft.showValue ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => updateDraft(draft.id, { isSecret: !draft.isSecret })}
                  className={cn(
                    'hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md border',
                    draft.isSecret
                      ? 'border-primary/40 text-primary'
                      : 'text-muted-foreground border-input'
                  )}
                  title={draft.isSecret ? 'Encrypted secret' : 'Plain value — click to encrypt'}
                  disabled={savingKey === '__new__'}
                >
                  <Lock className="h-3.5 w-3.5" />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  onClick={() => removeDraft(draft.id)}
                  disabled={savingKey === '__new__'}
                  aria-label="Remove row"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDrafts(prev => [...prev, makeDraft()])}
            disabled={savingKey === '__new__'}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add another
          </Button>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={resetAdd} disabled={savingKey === '__new__'}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveAll} disabled={savingKey === '__new__'}>
              {savingKey === '__new__' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="h-11 w-full border-dashed" onClick={startAdding}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variable
        </Button>
      )}

      {vars.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No environment variables.</p>
      )}
    </div>
  );
}

function stripEnvQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\n])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvText(content: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eqIdx + 1).trim();
    // Drop trailing unquoted inline comments (e.g. `VAL=foo # note`)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    value = stripEnvQuotes(value);
    if (seen.has(key)) {
      const prev = out.findIndex(e => e.key === key);
      if (prev !== -1) out[prev] = { key, value };
    } else {
      seen.add(key);
      out.push({ key, value });
    }
  }
  return out;
}
