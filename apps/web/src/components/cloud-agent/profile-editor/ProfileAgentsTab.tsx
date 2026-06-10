/** Agents tab for the profile editor (modern replacement for "custom modes"). */
'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Bot, Pencil, ChevronDown, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { cn } from '@/lib/utils';
import { useProfileMutations, type ProfileAgent } from '@/hooks/useCloudAgentProfiles';
import type { AgentConfig, PermissionRule } from '@kilocode/db/schema-types';

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const BUILTIN_SLUGS = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

/**
 * Tools the UI exposes as disableable per agent. Cloud sessions run in a
 * sandbox where every tool is allowed by default; the only customization we
 * surface is "turn this tool off for this agent", which emits `deny` for the
 * tool. The CLI's richer permission shapes (per-pattern maps, ask, etc.) are
 * preserved on save but not editable here.
 */
const PERMISSION_TOOLS = [
  'read',
  'edit',
  'bash',
  'glob',
  'grep',
  'list',
  'task',
  'skill',
  'webfetch',
  'websearch',
  'codesearch',
  'mcp',
] as const;
type PermissionTool = (typeof PERMISSION_TOOLS)[number];

type Props = {
  profileId: string;
  organizationId: string | undefined;
  agents: ProfileAgent[];
};

export function ProfileAgentsTab({ profileId, organizationId, agents }: Props) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-2 p-4">
      {agents.map(agent =>
        editingId === agent.id ? (
          <AgentForm
            key={agent.id}
            profileId={profileId}
            organizationId={organizationId}
            agent={agent}
            onDone={() => setEditingId(null)}
          />
        ) : (
          <AgentRow
            key={agent.id}
            agent={agent}
            profileId={profileId}
            organizationId={organizationId}
            onEdit={() => setEditingId(agent.id)}
          />
        )
      )}

      {isAdding ? (
        <AgentForm
          profileId={profileId}
          organizationId={organizationId}
          onDone={() => setIsAdding(false)}
        />
      ) : (
        <Button
          variant="outline"
          className="h-11 w-full border-dashed"
          onClick={() => setIsAdding(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add agent
        </Button>
      )}

      {agents.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No agents yet.</p>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  profileId,
  organizationId,
  onEdit,
}: {
  agent: ProfileAgent;
  profileId: string;
  organizationId: string | undefined;
  onEdit: () => void;
}) {
  const { deleteAgent } = useProfileMutations({ organizationId });
  const [deleting, setDeleting] = useState(false);

  const visibility = agent.config.mode ?? 'primary';

  return (
    <div className="hover:bg-accent/50 rounded-lg border p-3 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="text-muted-foreground h-4 w-4" />
            <span className="text-sm font-medium">{agent.name}</span>
            <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs">{agent.slug}</code>
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              {visibility}
            </span>
          </div>
          {(agent.config.model || agent.config.variant) && (
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              {agent.config.model && (
                <span>
                  model: <code className="font-mono">{agent.config.model}</code>
                </span>
              )}
              {agent.config.variant && (
                <span>
                  effort: <code className="font-mono">{agent.config.variant}</code>
                </span>
              )}
            </div>
          )}
          {agent.config.description && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
              {agent.config.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit agent">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <InlineDeleteConfirmation
            onDelete={async () => {
              setDeleting(true);
              try {
                await deleteAgent.mutateAsync({
                  profileId,
                  organizationId,
                  agentId: agent.id,
                });
                toast.success(`Agent "${agent.name}" deleted`);
              } catch (error) {
                console.error('Failed to delete agent:', error);
                toast.error('Failed to delete agent');
              } finally {
                setDeleting(false);
              }
            }}
            isLoading={deleting}
          />
        </div>
      </div>
    </div>
  );
}

type FormState = {
  slug: string;
  name: string;
  prompt: string;
  description: string;
  visibility: 'primary' | 'subagent' | 'all';
  model: string;
  /**
   * Thinking-effort variant name for models that support it (e.g.
   * `"high"`, `"max"`). Empty string means "inherit the session default for
   * this model". Ignored by the CLI on models without variants.
   */
  variant: string;
  temperature: string;
  topP: string;
  steps: string;
  /** Tools the user wants turned off for this agent. Everything else is allowed. */
  disabledTools: Set<PermissionTool>;
};

function readDisabledTools(permission: AgentConfig['permission'] | undefined): Set<PermissionTool> {
  const out = new Set<PermissionTool>();
  if (!permission || typeof permission !== 'object') return out;
  const map = permission as Record<string, PermissionRule>;
  for (const tool of PERMISSION_TOOLS) {
    if (map[tool] === 'deny') out.add(tool);
  }
  return out;
}

function buildInitialState(agent: ProfileAgent | undefined): FormState {
  const c = agent?.config ?? {};
  return {
    slug: agent?.slug ?? '',
    name: agent?.name ?? '',
    prompt: c.prompt ?? '',
    description: c.description ?? '',
    visibility: c.mode ?? 'primary',
    model: c.model ?? '',
    variant: c.variant ?? '',
    temperature: c.temperature !== undefined ? String(c.temperature) : '',
    topP: c.top_p !== undefined ? String(c.top_p) : '',
    steps: c.steps !== undefined ? String(c.steps) : '',
    disabledTools: readDisabledTools(c.permission),
  };
}

/**
 * Apply UI disable toggles onto the existing permission map, preserving any
 * non-string (per-pattern) rules and any unrelated tool keys a user may have
 * imported. Toggling a tool off writes `deny`; toggling it back on clears a
 * simple string rule but leaves per-pattern maps alone.
 */
function mergePermissions(
  existing: AgentConfig['permission'] | undefined,
  disabledTools: Set<PermissionTool>
): AgentConfig['permission'] | undefined {
  const base: Record<string, PermissionRule> =
    existing && typeof existing === 'object' ? { ...existing } : {};
  for (const tool of PERMISSION_TOOLS) {
    if (disabledTools.has(tool)) {
      base[tool] = 'deny';
    } else if (typeof base[tool] === 'string') {
      delete base[tool];
    }
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function FieldHint({ hint }: { hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function FieldLabel({
  htmlFor,
  children,
  required,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>
        {children}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </Label>
      {hint && <FieldHint hint={hint} />}
    </div>
  );
}

function AgentForm({
  profileId,
  organizationId,
  agent,
  onDone,
}: {
  profileId: string;
  organizationId: string | undefined;
  agent?: ProfileAgent;
  onDone: () => void;
}) {
  const { createAgent, updateAgent } = useProfileMutations({ organizationId });
  const [state, setState] = useState<FormState>(() => buildInitialState(agent));
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { data: modelsData } = useModelSelectorList(organizationId);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data ?? []).map(m => ({
        id: m.id,
        name: m.name,
        isFree: m.isFree,
        variants: m.opencode?.variants ? Object.keys(m.opencode.variants) : undefined,
      })),
    [modelsData]
  );
  const availableVariants =
    (state.model && modelOptions.find(m => m.id === state.model)?.variants) || [];

  const handleSave = async () => {
    const trimmedSlug = state.slug.trim();
    const trimmedName = state.name.trim();

    if (!SLUG_PATTERN.test(trimmedSlug)) {
      toast.error('Slug must start with a letter and contain only letters, digits, and dashes');
      return;
    }
    if (BUILTIN_SLUGS.has(trimmedSlug)) {
      toast.error(`Slug "${trimmedSlug}" conflicts with a built-in agent; pick a different slug`);
      return;
    }
    if (!trimmedName) {
      toast.error('Display name is required');
      return;
    }

    const parseNumber = (v: string): number | undefined => {
      const t = v.trim();
      if (!t) return undefined;
      const n = parseFloat(t);
      return Number.isFinite(n) ? n : undefined;
    };
    const parseInt10 = (v: string): number | undefined => {
      const t = v.trim();
      if (!t) return undefined;
      const n = parseInt(t, 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    // Only persist the effort variant when the selected model actually
    // supports it — otherwise the CLI would silently ignore it, and users
    // would be confused seeing a stale value next to a non-thinking model.
    const variantAllowed = state.variant && availableVariants.includes(state.variant);

    const config: AgentConfig = {
      prompt: state.prompt.trim() || undefined,
      description: state.description.trim() || undefined,
      mode: state.visibility,
      // Empty model string clears the override (undefined); users can also
      // type `null` text, but we accept only empty-string as "inherit default".
      model: state.model.trim() || undefined,
      variant: variantAllowed ? state.variant : undefined,
      temperature: parseNumber(state.temperature),
      top_p: parseNumber(state.topP),
      steps: parseInt10(state.steps),
      // Preserve any `hidden` / `disable` values that were set outside this
      // UI (e.g. imported from the kilocode extension). The cloud UI does not
      // surface these flags directly — delete an agent instead of disabling it.
      hidden: agent?.config.hidden,
      disable: agent?.config.disable,
      permission: mergePermissions(agent?.config.permission, state.disabledTools),
    };

    setSaving(true);
    try {
      if (agent) {
        await updateAgent.mutateAsync({
          profileId,
          organizationId,
          agentId: agent.id,
          slug: trimmedSlug,
          name: trimmedName,
          config,
        });
        toast.success(`Agent "${trimmedName}" updated`);
      } else {
        await createAgent.mutateAsync({
          profileId,
          organizationId,
          slug: trimmedSlug,
          name: trimmedName,
          config,
        });
        toast.success(`Agent "${trimmedName}" added`);
      }
      onDone();
    } catch (error) {
      console.error('Failed to save agent:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="agent-slug"
            required
            hint="Short identifier used to select this agent (e.g. `my-reviewer`). Lowercase letters, digits, and dashes; must start with a letter. Cannot match a built-in slug."
          >
            Slug
          </FieldLabel>
          <Input
            id="agent-slug"
            value={state.slug}
            onChange={e =>
              setState({
                ...state,
                slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
              })
            }
            placeholder="my-agent"
            className="font-mono"
            autoFocus
          />
        </div>
        <div className="grid gap-2">
          <FieldLabel
            htmlFor="agent-name"
            required
            hint="Human-readable name shown in the agent picker."
          >
            Display name
          </FieldLabel>
          <Input
            id="agent-name"
            value={state.name}
            onChange={e => setState({ ...state, name: e.target.value })}
            placeholder="My Agent"
          />
        </div>
      </div>

      <div className="grid gap-2">
        <FieldLabel
          htmlFor="agent-prompt"
          hint="Prepended to the system prompt whenever this agent runs. Leave empty to use the built-in prompt for the selected visibility."
        >
          System prompt
        </FieldLabel>
        <Textarea
          id="agent-prompt"
          value={state.prompt}
          onChange={e => setState({ ...state, prompt: e.target.value })}
          placeholder="You are a ..."
          rows={6}
          className="text-sm"
        />
      </div>

      <div className="grid gap-2">
        <FieldLabel
          htmlFor="agent-description"
          hint="Short blurb shown under the agent name in pickers and autocomplete."
        >
          Description
        </FieldLabel>
        <Input
          id="agent-description"
          value={state.description}
          onChange={e => setState({ ...state, description: e.target.value })}
          placeholder="Shown under the name in the picker"
        />
      </div>

      <div className="grid gap-2">
        <FieldLabel hint="Override the session's default model when this agent runs. Leave unset to inherit the session default. For models that support thinking effort, the picker on the right lets you override the effort level too.">
          Model override
        </FieldLabel>
        <div className="flex gap-2">
          <ModelCombobox
            label=""
            models={modelOptions}
            value={state.model || undefined}
            onValueChange={v => {
              // Drop a stale effort value whenever the new model doesn't offer it.
              const nextVariants = (v && modelOptions.find(m => m.id === v)?.variants) || [];
              setState({
                ...state,
                model: v,
                variant: nextVariants.includes(state.variant) ? state.variant : '',
              });
            }}
            isLoading={!modelsData}
            placeholder="Use session default"
            variant="compact"
            // `size="sm"` buttons use `text-xs`, which looks noticeably smaller
            // than the form's `Input` fields (md:text-sm). Bump back up so the
            // model picker reads at the same scale as Description / Slug / etc.
            className="min-w-0 flex-1 text-sm"
            // This editor lives inside a Radix Dialog; without `modal` the dialog
            // intercepts wheel events and the model list cannot be scrolled.
            modal
          />
          {availableVariants.length > 0 && (
            <VariantCombobox
              variants={availableVariants}
              value={state.variant || undefined}
              onValueChange={v => setState({ ...state, variant: v })}
              className="shrink-0 text-sm"
            />
          )}
        </div>
        {(state.model || state.variant) && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground w-fit text-xs underline"
            onClick={() => setState({ ...state, model: '', variant: '' })}
          >
            Clear model override
          </button>
        )}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted/40',
              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors'
            )}
          >
            <span className="flex items-center gap-1.5">
              <ChevronDown
                className={cn('h-4 w-4 transition-transform', advancedOpen && 'rotate-180')}
              />
              <span className="font-medium">Advanced</span>
            </span>
            <span className="text-muted-foreground/70 text-xs">visibility, sampling, tools</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
          <div className="bg-muted/30 mt-2 space-y-5 rounded-md border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="agent-visibility"
                  hint="Primary: selectable from the picker. Subagent: only callable from another agent via the task tool. All: both."
                >
                  Visibility
                </FieldLabel>
                <Select
                  value={state.visibility}
                  onValueChange={v =>
                    setState({ ...state, visibility: v as FormState['visibility'] })
                  }
                >
                  <SelectTrigger id="agent-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary — shown in the picker</SelectItem>
                    <SelectItem value="subagent">Subagent — only callable from others</SelectItem>
                    <SelectItem value="all">All — both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="agent-steps"
                  hint="Maximum number of tool-use steps before the agent is forced to stop. Inherits the session limit if unset."
                >
                  Max steps
                </FieldLabel>
                <Input
                  id="agent-steps"
                  value={state.steps}
                  onChange={e => setState({ ...state, steps: e.target.value })}
                  placeholder="e.g. 50"
                  inputMode="numeric"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="agent-temperature"
                  hint="Sampling temperature. Lower = more deterministic, higher = more creative. Typical range 0–1."
                >
                  Temperature
                </FieldLabel>
                <Input
                  id="agent-temperature"
                  value={state.temperature}
                  onChange={e => setState({ ...state, temperature: e.target.value })}
                  placeholder="e.g. 0.2"
                  inputMode="decimal"
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="agent-top-p"
                  hint="Nucleus sampling cutoff. Only tokens within the top `p` probability mass are considered."
                >
                  top_p
                </FieldLabel>
                <Input
                  id="agent-top-p"
                  value={state.topP}
                  onChange={e => setState({ ...state, topP: e.target.value })}
                  placeholder="e.g. 0.95"
                  inputMode="decimal"
                />
              </div>
            </div>

            <div className="grid gap-2">
              <FieldLabel hint="Every tool is allowed by default. Uncheck a tool to deny it for this agent only.">
                Tools
              </FieldLabel>
              <div className="bg-background/60 grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-3">
                {PERMISSION_TOOLS.map(tool => {
                  const enabled = !state.disabledTools.has(tool);
                  return (
                    <label
                      key={tool}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors"
                    >
                      <Checkbox
                        checked={enabled}
                        onCheckedChange={checked => {
                          const next = new Set(state.disabledTools);
                          if (checked) next.delete(tool);
                          else next.add(tool);
                          setState({ ...state, disabledTools: next });
                        }}
                      />
                      <span className="font-mono text-xs">{tool}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : agent ? 'Save' : 'Add agent'}
        </Button>
      </div>
    </div>
  );
}
