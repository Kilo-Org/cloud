'use client';

import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PERMISSION_LENGTH,
  isToolLevelPermission,
  type PermissionTier,
} from '@/lib/organizations/permissions/types';
import { validatePermissionRule } from '@/lib/organizations/permissions/validate';
import { KNOWN_PERMISSIONS, TIER_OPTIONS } from './permission-display';
import type { PermissionRuleRow } from './permission-types';

export function showRuleWarnings(warnings: readonly string[]) {
  for (const warning of warnings) toast.warning(warning);
}

export function PermissionRuleDialog({
  organizationId,
  rule,
  onClose,
}: {
  organizationId: string;
  rule?: PermissionRuleRow;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tierId = useId();
  const tierHelpId = useId();
  const permissionId = useId();
  const permissionListId = useId();
  const patternId = useId();
  const patternHelpId = useId();
  const descriptionId = useId();
  const messagesId = useId();
  const [tier, setTier] = useState<PermissionTier>(rule?.tier ?? 'specific_deny');
  const [permission, setPermission] = useState(rule?.permission ?? 'bash');
  const [patternDraft, setPatternDraft] = useState(rule?.pattern ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');

  const toolLevel = isToolLevelPermission(permission.trim());
  const pattern = toolLevel ? '*' : patternDraft;
  const validation = validatePermissionRule({ tier, permission, pattern, description });
  const visibleErrors = permission.trim() === '' && pattern === '' ? [] : validation.errors;
  const canSubmit = validation.errors.length === 0;
  const tierDescription = TIER_OPTIONS.find(option => option.value === tier)?.description;

  const onSaved = async (result: { warnings: string[] }) => {
    await queryClient.invalidateQueries({
      queryKey: trpc.organizations.permissionRules.pathKey(),
    });
    toast.success(rule ? 'Rule saved.' : 'Rule added.');
    showRuleWarnings(result.warnings);
    onClose();
  };
  const addMutation = useMutation(
    trpc.organizations.permissionRules.add.mutationOptions({ onSuccess: onSaved })
  );
  const updateMutation = useMutation(
    trpc.organizations.permissionRules.update.mutationOptions({ onSuccess: onSaved })
  );
  const mutation = rule ? updateMutation : addMutation;

  const submit = () => {
    const values = {
      organizationId,
      tier,
      permission: permission.trim(),
      pattern,
      description: description.trim() || null,
    };
    if (rule) updateMutation.mutate({ ...values, ruleId: rule.id });
    else addMutation.mutate(values);
  };

  const serverErrors = mutation.isError ? [mutation.error.message] : [];
  const errors = [...visibleErrors, ...serverErrors];
  const hasMessages = errors.length > 0 || validation.warnings.length > 0;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'Add rule'}</DialogTitle>
          <DialogDescription>
            The highest matching rule decides. When no rule matches, the default applies.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            if (canSubmit) submit();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={tierId}>Rule type</Label>
            <Select
              value={tier}
              onValueChange={next => {
                setTier(next as PermissionTier);
                mutation.reset();
              }}
            >
              <SelectTrigger id={tierId} className="w-full" aria-describedby={tierHelpId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIER_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={tierHelpId} className="text-muted-foreground text-sm">
              {tierDescription}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={permissionId}>Permission</Label>
            <Input
              id={permissionId}
              list={permissionListId}
              value={permission}
              maxLength={MAX_PERMISSION_LENGTH}
              placeholder="bash"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={event => {
                setPermission(event.target.value);
                mutation.reset();
              }}
            />
            <datalist id={permissionListId}>
              {KNOWN_PERMISSIONS.map(known => (
                <option key={known} value={known} />
              ))}
            </datalist>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={patternId}>Pattern</Label>
            <Input
              id={patternId}
              value={pattern}
              readOnly={toolLevel}
              maxLength={MAX_PATTERN_LENGTH}
              placeholder="git push *"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={errors.length > 0}
              aria-describedby={[patternHelpId, hasMessages ? messagesId : null]
                .filter(Boolean)
                .join(' ')}
              onChange={event => {
                setPatternDraft(event.target.value);
                mutation.reset();
              }}
            />
            <p id={patternHelpId} className="text-muted-foreground text-sm">
              {toolLevel
                ? `“${permission.trim()}” is checked once per tool call, so its pattern is always *.`
                : 'Matched against each simple command. * matches anything, ? matches one character, and a trailing “ *” also matches the bare command.'}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={descriptionId}>Description (optional)</Label>
            <Input
              id={descriptionId}
              value={description}
              maxLength={MAX_DESCRIPTION_LENGTH}
              placeholder="Why this rule exists"
              onChange={event => setDescription(event.target.value)}
            />
          </div>

          {hasMessages && (
            <div id={messagesId} className="grid gap-1">
              {errors.map(error => (
                <p key={error} role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ))}
              {validation.warnings.map(warning => (
                <p key={warning} className="text-status-warning text-sm">
                  {warning}
                </p>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || mutation.isPending}>
              {rule
                ? mutation.isPending
                  ? 'Saving…'
                  : 'Save rule'
                : mutation.isPending
                  ? 'Adding…'
                  : 'Add rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
