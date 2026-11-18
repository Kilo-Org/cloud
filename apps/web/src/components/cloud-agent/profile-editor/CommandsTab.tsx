'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Loader2, Trash2, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  useProfileMutations,
  useCombinedProfileMutations,
} from '@/hooks/useCloudAgentProfiles';

type CommandsTabProps = {
  profileId: string;
  organizationId?: string;
  commands: { sequence: number; command: string }[];
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
  readOnly?: boolean;
};

export function CommandsTab({
  profileId,
  organizationId,
  commands,
  mutations,
  readOnly = false,
}: CommandsTabProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newCommand, setNewCommand] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newCommand.trim()) {
      toast.error('Command is required');
      return;
    }
    const current = commands.map(c => c.command);
    setSaving(true);
    try {
      await mutations.setCommands.mutateAsync({
        profileId,
        commands: [...current, newCommand.trim()],
        organizationId,
      });
      toast.success('Command added');
      setIsAdding(false);
      setNewCommand('');
    } catch {
      toast.error('Failed to add command');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (index: number) => {
    const updated = commands.filter((_, i) => i !== index).map(c => c.command);
    setSaving(true);
    try {
      await mutations.setCommands.mutateAsync({ profileId, commands: updated, organizationId });
      toast.success('Command deleted');
    } catch {
      toast.error('Failed to delete command');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-1.5">
        <Terminal className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-xs font-medium">Setup Commands</span>
      </div>

      {commands.map((cmd, i) => (
        <div
          key={`${cmd.sequence}-${i}`}
          className="hover:bg-accent/50 flex items-center gap-2 rounded-lg border p-2 transition-colors"
        >
          <span className="text-muted-foreground w-5 shrink-0 text-xs">{i + 1}.</span>
          <code className="bg-muted flex-1 truncate rounded px-2 py-0.5 font-mono text-xs">
            {cmd.command}
          </code>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive h-7 w-7 shrink-0"
              onClick={() => handleDelete(i)}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}

      {isAdding ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">Command</Label>
            <Input
              value={newCommand}
              onChange={e => setNewCommand(e.target.value)}
              placeholder="npm install"
              className="font-mono text-sm"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && !saving && handleAdd()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAdding(false);
                setNewCommand('');
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
          </div>
        </div>
      ) : (
        !readOnly && (
          <Button
            variant="outline"
            className="h-11 w-full border-dashed"
            onClick={() => setIsAdding(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Command
          </Button>
        )
      )}

      {commands.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">
          No startup commands. Commands run in order when the session starts.
        </p>
      )}
    </div>
  );
}
