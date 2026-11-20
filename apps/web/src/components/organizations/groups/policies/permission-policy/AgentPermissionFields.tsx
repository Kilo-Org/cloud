import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  actionLabels,
  actionOptions,
  PolicySelect,
  shellKinds,
  shellLabels,
  shellOptions,
  type AgentDraft,
  type AgentPermissionSource,
  type PolicyRule,
  type ToolDecision,
} from './permission-policy-ui';

const knownTools: Readonly<Record<string, string>> = {
  edit: 'File edits',
  websearch: 'Web search',
  webfetch: 'Web fetch',
  browser_open: 'Browser access',
  external_directory: 'External directories',
  bash: 'Shell tool',
};

export function AgentPermissionFields({
  draft,
  sources,
  disabled,
  onChange,
}: {
  draft: AgentDraft;
  sources: AgentPermissionSource[];
  disabled: boolean;
  onChange: (draft: AgentDraft) => void;
}) {
  const unrestrictedBlocker = sources.find(
    source => source.permissions.unrestricted_mode === 'deny'
  );
  const unrestrictedAllow = sources.find(
    source => source.permissions.unrestricted_mode === 'allow'
  );
  const autoApproveBlocker = sources.find(source => source.permissions.auto_approve === 'deny');
  const shellSources = sources.flatMap(({ name, permissions }) =>
    permissions.shell === undefined ? [] : [{ name, shell: permissions.shell }]
  );
  return (
    <Tabs defaultValue="tools">
      <TabsList aria-label="Agent permission sections">
        <TabsTrigger value="tools">Tools</TabsTrigger>
        <TabsTrigger value="shell">Shell</TabsTrigger>
      </TabsList>
      <TabsContent value="tools" className="grid gap-5 pt-2">
        <PolicySelect
          label="Unrestricted mode"
          value={draft.unrestricted_mode ?? 'inherit'}
          options={[
            { value: 'inherit', label: 'Use inherited policy' },
            { ...actionOptions[0], disabled: Boolean(unrestrictedBlocker) },
            { ...actionOptions[2], disabled: Boolean(unrestrictedBlocker) },
          ]}
          disabled={
            disabled || (Boolean(unrestrictedBlocker) && draft.unrestricted_mode === undefined)
          }
          description={
            unrestrictedBlocker?.name === 'Organization default'
              ? 'Blocked by the organization default. A group cannot change this restriction.'
              : unrestrictedBlocker
                ? `Blocked by ${unrestrictedBlocker.name}. This set cannot change the restriction.`
                : unrestrictedAllow?.name === 'Organization default'
                  ? 'The organization default does not block unrestricted mode.'
                  : 'An Allow decision does not override stricter settings.'
          }
          onChange={mode =>
            onChange({ ...draft, unrestricted_mode: mode === 'inherit' ? undefined : mode })
          }
        />
        <PolicySelect
          label="Auto-approve for managed actions"
          value={draft.auto_approve ?? 'inherit'}
          options={[
            { value: 'inherit', label: 'No additional restriction' },
            { value: 'deny', label: 'Disable auto-approve', disabled: Boolean(autoApproveBlocker) },
          ]}
          disabled={disabled || (Boolean(autoApproveBlocker) && draft.auto_approve === undefined)}
          description={
            autoApproveBlocker?.name === 'Organization default'
              ? 'Disabled by the organization default. A group cannot re-enable it.'
              : autoApproveBlocker
                ? `Disabled by ${autoApproveBlocker.name}. This permission set cannot re-enable it.`
                : 'Requires manual approval when a managed action needs approval. Members can still auto-approve eligible actions outside managed policy.'
          }
          onChange={mode =>
            onChange({ ...draft, auto_approve: mode === 'deny' ? mode : undefined })
          }
        />
        <ToolPermissions draft={draft} sources={sources} disabled={disabled} onChange={onChange} />
      </TabsContent>
      <TabsContent value="shell" className="grid gap-4 pt-2">
        <PolicySelect
          label="Shell profile policy"
          value={draft.shell === undefined ? 'inherit' : 'configure'}
          options={[
            { value: 'inherit', label: 'Use inherited policy' },
            { value: 'configure', label: 'Configure shell profiles' },
          ]}
          disabled={disabled}
          description="Inherit adds no shell restriction here. Configuring profiles blocks every shell kind without a profile, including unconfigured Bash or PowerShell."
          onChange={mode => onChange({ ...draft, shell: mode === 'configure' ? {} : undefined })}
        />
        {shellSources.map(({ name, shell }) => (
          <div key={name} className="type-label text-muted-foreground grid gap-1 border-l pl-3">
            <p className="text-foreground font-medium">{name} shell restrictions</p>
            {shellKinds.map(kind => {
              const profile = shell[kind];
              return (
                <p key={kind}>
                  {shellLabels[kind]}:{' '}
                  {profile
                    ? `${profile.fallback ? actionLabels[profile.fallback] : 'No fallback selected'} for unlisted commands · ${profile.rules.length} rules`
                    : 'Blocked (no profile)'}
                </p>
              );
            })}
          </div>
        ))}
        {draft.shell !== undefined &&
          shellKinds.map(kind => {
            const profile = draft.shell?.[kind];
            const blocker = shellSources.find(({ shell }) => {
              const inherited = shell[kind];
              return !inherited || (inherited.rules.length === 0 && inherited.fallback === 'deny');
            });
            const requiresApproval = shellSources.some(({ shell }) => {
              const inherited = shell[kind];
              return inherited?.fallback === 'ask' && inherited.rules.length === 0;
            });
            return (
              <fieldset key={kind} className="grid min-w-0 gap-3 border-t pt-3" disabled={disabled}>
                <legend className="type-body font-medium pr-2">{shellLabels[kind]}</legend>
                {blocker && (
                  <p className="type-label text-muted-foreground">
                    Blocked by{' '}
                    {blocker.name === 'Organization default'
                      ? 'the organization default'
                      : blocker.name}{' '}
                    ({blocker.shell[kind] ? 'no command exceptions' : 'no profile'}).
                  </p>
                )}
                {!profile ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    disabled={Boolean(blocker)}
                    onClick={() =>
                      onChange({ ...draft, shell: { ...draft.shell, [kind]: { rules: [] } } })
                    }
                  >
                    <Plus className="size-4" /> Add {shellLabels[kind]} profile
                  </Button>
                ) : (
                  <>
                    <fieldset disabled={Boolean(blocker)} className="grid min-w-0 gap-3">
                      <PolicySelect
                        label="Unlisted commands"
                        value={profile.fallback ?? ''}
                        options={[
                          { value: '', label: 'Choose a fallback', disabled: true },
                          ...shellOptions,
                        ]}
                        onChange={fallback => {
                          if (fallback)
                            onChange({
                              ...draft,
                              shell: { ...draft.shell, [kind]: { ...profile, fallback } },
                            });
                        }}
                      />
                      <RuleList
                        rules={profile.rules}
                        patternLabel="Command pattern"
                        allowDisabled={requiresApproval}
                        onChange={rules =>
                          onChange({
                            ...draft,
                            shell: { ...draft.shell, [kind]: { ...profile, rules } },
                          })
                        }
                      />
                    </fieldset>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-fit"
                      onClick={() => {
                        const shell = { ...draft.shell };
                        delete shell[kind];
                        onChange({ ...draft, shell });
                      }}
                    >
                      Remove {shellLabels[kind]} profile
                    </Button>
                  </>
                )}
              </fieldset>
            );
          })}
      </TabsContent>
    </Tabs>
  );
}

function ToolPermissions({
  draft,
  sources,
  disabled,
  onChange,
}: {
  draft: AgentDraft;
  sources: AgentPermissionSource[];
  disabled: boolean;
  onChange: (draft: AgentDraft) => void;
}) {
  const [tool, setTool] = useState('external_directory');
  const [customTool, setCustomTool] = useState('');
  const [customToolError, setCustomToolError] = useState('');
  const customToolId = useId();
  const tools = draft.tools ?? {};
  const toolKeys = [
    ...new Set([
      ...Object.keys(knownTools),
      ...Object.keys(tools),
      ...sources.flatMap(source => Object.keys(source.permissions.tools ?? {})),
      tool,
    ]),
  ];
  const decision = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  const inheritedDecisions = sources.map(source => {
    const sourceTools = source.permissions.tools ?? {};
    const decision = Object.hasOwn(sourceTools, tool) ? sourceTools[tool] : undefined;
    const fallback = typeof decision === 'object' ? decision.fallback : decision;
    const ruleCount = typeof decision === 'object' ? decision.rules.length : 0;
    return { name: source.name, fallback, ruleCount };
  });
  const blockedByInherited = inheritedDecisions.some(
    ({ fallback, ruleCount }) => fallback === 'deny' && ruleCount === 0
  );
  const requiresApproval = inheritedDecisions.some(
    ({ fallback, ruleCount }) => fallback === 'ask' && ruleCount === 0
  );
  const availableActions = actionOptions.map(option => ({
    ...option,
    disabled: blockedByInherited || (requiresApproval && option.value === 'allow'),
  }));

  function updateTool(value?: ToolDecision) {
    if (value !== undefined) {
      onChange({ ...draft, tools: { ...tools, [tool]: value } });
    } else {
      const next = { ...tools };
      delete next[tool];
      onChange({ ...draft, tools: Object.keys(next).length ? next : undefined });
    }
  }

  return (
    <section className="grid gap-3 border-t pt-4">
      <div>
        <h3 className="type-body font-medium">Tool permissions</h3>
        <p className="type-label text-muted-foreground">
          Allow does not override a stricter organization, group, or local decision.
        </p>
      </div>
      <PolicySelect
        label="Tool"
        value={tool}
        options={toolKeys.map(key => ({
          value: key,
          label: `${Object.hasOwn(knownTools, key) ? `${knownTools[key]} (${key})` : key}${Object.hasOwn(tools, key) ? ' · configured' : ''}`,
        }))}
        onChange={setTool}
      />
      <fieldset aria-label={tool} className="grid min-w-0 gap-3" disabled={disabled}>
        {inheritedDecisions.map(({ name, fallback, ruleCount }) => (
          <p key={name} className="type-label text-muted-foreground">
            {fallback
              ? `${name}: ${actionLabels[fallback]}.${ruleCount ? ' Applies to unmatched calls.' : ''} ${name === 'Organization default' ? 'A group policy cannot relax it.' : 'This permission set cannot relax it.'}`
              : `No decision from ${name === 'Organization default' ? 'the organization default' : name} for unmatched calls.`}
            {ruleCount
              ? ` ${name} also defines ${ruleCount} ${ruleCount === 1 ? 'resource rule' : 'resource rules'}.`
              : ''}
          </p>
        ))}
        <PolicySelect
          label="Tool decision"
          value={typeof decision === 'object' ? 'rules' : (decision ?? 'inherit')}
          disabled={blockedByInherited && decision === undefined}
          options={[
            { value: 'inherit', label: 'Use inherited policy' },
            ...availableActions,
            ...(tool === 'bash'
              ? []
              : [
                  {
                    value: 'rules',
                    label: 'Resource rules',
                    disabled: blockedByInherited,
                  } as const,
                ]),
          ]}
          onChange={value => {
            if (value === 'rules')
              updateTool({
                rules: [],
                fallback: typeof decision === 'string' ? decision : undefined,
              });
            else updateTool(value === 'inherit' ? undefined : value);
          }}
        />
        {typeof decision === 'object' && (
          <fieldset disabled={blockedByInherited} className="grid min-w-0 gap-3">
            <PolicySelect
              label="Unmatched calls"
              value={decision.fallback ?? 'inherit'}
              options={[{ value: 'inherit', label: 'Use inherited policy' }, ...availableActions]}
              onChange={value =>
                updateTool({ ...decision, fallback: value === 'inherit' ? undefined : value })
              }
            />
            <RuleList
              rules={decision.rules}
              patternLabel="Resource pattern"
              allowDisabled={requiresApproval}
              onChange={rules => updateTool({ ...decision, rules })}
            />
          </fieldset>
        )}
      </fieldset>
      {!disabled && (
        <div className="grid gap-1.5">
          <Label htmlFor={customToolId}>Custom tool key</Label>
          <div className="flex gap-2">
            <Input
              id={customToolId}
              value={customTool}
              maxLength={128}
              onChange={event => {
                setCustomTool(event.target.value);
                setCustomToolError('');
              }}
            />
            <Button
              variant="outline"
              disabled={!customTool.trim()}
              onClick={() => {
                const key = customTool.trim();
                if (key === '__proto__' || !/^[A-Za-z0-9_.*:-]+$/.test(key)) {
                  setCustomToolError('Enter a valid tool key.');
                  return;
                }
                setTool(key);
                setCustomTool('');
              }}
            >
              Select tool
            </Button>
          </div>
          {customToolError && (
            <p role="alert" className="type-label text-status-destructive">
              {customToolError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RuleList({
  rules,
  onChange,
  patternLabel,
  allowDisabled,
}: {
  rules: PolicyRule[];
  onChange: (rules: PolicyRule[]) => void;
  patternLabel: string;
  allowDisabled: boolean;
}) {
  const id = useId();

  function move(index: number, to: number) {
    const next = [...rules];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  }

  return (
    <div className="grid gap-2">
      <p className="type-label text-muted-foreground">
        Rules use Kilo permission patterns. The last matching rule wins in this policy.
      </p>
      <ol className="grid gap-3">
        {rules.map((rule, index) => (
          <li
            key={index}
            className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-${index}`}>
                {patternLabel} {index + 1}
              </Label>
              <Input
                id={`${id}-${index}`}
                className="font-mono"
                value={rule.pattern}
                maxLength={512}
                onChange={event =>
                  onChange(
                    rules.map((current, position) =>
                      position === index ? { ...current, pattern: event.target.value } : current
                    )
                  )
                }
              />
            </div>
            <PolicySelect
              label={`Rule ${index + 1} decision`}
              options={actionOptions.map(option => ({
                ...option,
                disabled: allowDisabled && option.value === 'allow',
              }))}
              value={rule.action}
              onChange={action =>
                onChange(
                  rules.map((current, position) =>
                    position === index ? { ...current, action } : current
                  )
                )
              }
            />
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                disabled={index === 0}
                aria-label={`Move rule ${index + 1} up`}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={index === rules.length - 1}
                aria-label={`Move rule ${index + 1} down`}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => onChange(rules.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={rules.length >= 100}
        onClick={() => onChange([...rules, { pattern: '', action: 'deny' }])}
      >
        <Plus className="size-4" /> Add rule
      </Button>
    </div>
  );
}
