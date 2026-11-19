'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AnthropicUserProfilesSettingsInputSchema,
  type AnthropicUserProfilesSettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatDate } from '@/lib/admin-utils';
import { formatZodError } from '@/lib/zod/format-zod-error';

type FormValues = {
  enabled: boolean;
  startAt: string;
  optedInUserIds: string;
  optedInOrganizationIds: string;
  optedOutUserIds: string;
  optedOutOrganizationIds: string;
};

type IdFieldKey = Exclude<keyof FormValues, 'enabled' | 'startAt'>;

const ID_FIELDS: readonly {
  key: IdFieldKey;
  label: string;
  description: string;
  placeholder: string;
}[] = [
  {
    key: 'optedInUserIds',
    label: 'Opted-in users',
    description: 'Users that get profiles before the start date.',
    placeholder: 'user-id',
  },
  {
    key: 'optedInOrganizationIds',
    label: 'Opted-in organizations',
    description: 'Organizations that get profiles before the start date.',
    placeholder: '00000000-0000-0000-0000-000000000000',
  },
  {
    key: 'optedOutUserIds',
    label: 'Opted-out users',
    description: 'Users that never get a profile or the header. Opt-out wins over opt-in.',
    placeholder: 'user-id',
  },
  {
    key: 'optedOutOrganizationIds',
    label: 'Opted-out organizations',
    description: 'Organizations that never get a profile or the header. Opt-out wins over opt-in.',
    placeholder: '00000000-0000-0000-0000-000000000000',
  },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formats an ISO timestamp as the local `YYYY-MM-DDTHH:mm` value of a datetime-local input. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toFormValues(settings: AnthropicUserProfilesSettings): FormValues {
  return {
    enabled: settings.enabled,
    startAt: toLocalInputValue(settings.start_at),
    optedInUserIds: settings.opted_in_user_ids.join('\n'),
    optedInOrganizationIds: settings.opted_in_organization_ids.join('\n'),
    optedOutUserIds: settings.opted_out_user_ids.join('\n'),
    optedOutOrganizationIds: settings.opted_out_organization_ids.join('\n'),
  };
}

function parseIds(value: string): string[] {
  return value
    .split('\n')
    .map(id => id.trim())
    .filter(id => id !== '');
}

function toStartAtInput(startAt: string): string | null {
  if (startAt === '') return null;
  const date = new Date(startAt);
  return Number.isNaN(date.getTime()) ? startAt : date.toISOString();
}

function toInput(values: FormValues, revision: number) {
  return {
    revision,
    enabled: values.enabled,
    start_at: toStartAtInput(values.startAt),
    opted_in_user_ids: parseIds(values.optedInUserIds),
    opted_in_organization_ids: parseIds(values.optedInOrganizationIds),
    opted_out_user_ids: parseIds(values.optedOutUserIds),
    opted_out_organization_ids: parseIds(values.optedOutOrganizationIds),
  };
}

function formatAttempts(attemptCount: number, lastAttemptAt: string | null): string {
  if (attemptCount === 0 || !lastAttemptAt) return 'Not attempted yet';
  const attempts = `${attemptCount} ${attemptCount === 1 ? 'attempt' : 'attempts'}`;
  return `${attempts}, last ${formatDate(lastAttemptAt)}`;
}

function ProfileDeletionsCard() {
  const trpc = useTRPC();
  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.gatewayConfig.listAnthropicUserProfileDeletions.queryOptions()
  );

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Profile deletions</CardTitle>
        <CardDescription>
          The daily cleanup deletes profiles that no user or organization uses anymore, and profiles
          of users who have been blocked for at least 30 days. Profiles are detached first and then
          deleted at Anthropic; the cleanup retries pending deletions. Shows pending deletions and
          those completed in the last 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading...
          </p>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 text-sm" role="alert">
            <p className="text-destructive">Could not load profile deletions: {error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : !data || data.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No profile deletions are pending or were completed recently.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Deleted at</TableHead>
                <TableHead>Profile ID</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Profile created</TableHead>
                <TableHead>Profile updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">
                    {row.deleted_at ? (
                      formatDate(row.deleted_at)
                    ) : (
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="warning">Pending</Badge>
                        <span className="text-muted-foreground text-xs">
                          {formatAttempts(row.attempt_count, row.last_attempt_at)}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.user_profile_id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{row.reason}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.kilo_user_id ? (
                      <Link
                        href={`/admin/users/${encodeURIComponent(row.kilo_user_id)}`}
                        className="underline underline-offset-4"
                      >
                        {row.kilo_user_id}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">N/A</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.profile_created_at ? formatDate(row.profile_created_at) : 'N/A'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.profile_updated_at ? formatDate(row.profile_updated_at) : 'N/A'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function AnthropicUserProfilesContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.gatewayConfig.getAnthropicUserProfiles.queryOptions()
  );

  const [values, setValues] = useState<FormValues | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setValues(toFormValues(data));
      setHasChanges(false);
      setConflictError(null);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.gatewayConfig.setAnthropicUserProfiles.mutationOptions({
      onSuccess: () => {
        setHasChanges(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayConfig.getAnthropicUserProfiles.queryKey(),
        });
        toast.success('Anthropic user profile settings updated');
      },
      onError: error => {
        if (error.data?.code === 'CONFLICT') {
          setConflictError(error.message);
          return;
        }
        toast.error(formatZodError(error));
      },
    })
  );

  if (isLoading || (data && !values)) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  if (!values) {
    return (
      <div className="flex flex-col items-start gap-2 py-8 text-sm" role="alert">
        <p className="text-destructive">
          Could not load Anthropic user profile settings{error ? `: ${error.message}` : '.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  function update(change: Partial<FormValues>) {
    if (!values) return;
    setValues({ ...values, ...change });
    setValidationError(null);
    setConflictError(null);
    setHasChanges(true);
  }

  function handleSave() {
    if (!values || !data) return;
    const parsed = AnthropicUserProfilesSettingsInputSchema.safeParse(
      toInput(values, data.revision)
    );
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    setValidationError(null);
    setConflictError(null);
    mutation.mutate(parsed.data);
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Anthropic user profiles</CardTitle>
          <CardDescription>
            Attributes Kilo-paid Claude requests to an Anthropic user profile per user or
            organization. Opted-in users and organizations get profiles once enabled. With a start
            date, everyone else gets them from then on; without one, only opt-ins do. Opt-out wins
            over opt-in. Bring-your-own-key, Claude billing, and ChatGPT routes never send the
            header. Changes apply within about a minute.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Switch
              id="anthropic-user-profiles-enabled"
              checked={values.enabled}
              onCheckedChange={enabled => update({ enabled })}
            />
            <Label htmlFor="anthropic-user-profiles-enabled">Enabled</Label>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="anthropic-user-profiles-start-at">Start date and time</Label>
            <p
              id="anthropic-user-profiles-start-at-description"
              className="text-muted-foreground text-xs"
            >
              Shown in your local time zone. Leave empty to limit profiles to opted-in users and
              organizations.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="anthropic-user-profiles-start-at"
                aria-describedby="anthropic-user-profiles-start-at-description"
                type="datetime-local"
                value={values.startAt}
                onChange={e => update({ startAt: e.target.value })}
                className="w-auto"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={values.startAt === ''}
                onClick={() => update({ startAt: '' })}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {ID_FIELDS.map(field => {
              const id = `anthropic-user-profiles-${field.key}`;
              return (
                <div key={field.key} className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={id}>{field.label}</Label>
                  <p id={`${id}-description`} className="text-muted-foreground text-xs">
                    {field.description} One ID per line.
                  </p>
                  <Textarea
                    id={id}
                    aria-describedby={`${id}-description`}
                    placeholder={field.placeholder}
                    value={values[field.key]}
                    onChange={e => update({ [field.key]: e.target.value })}
                    rows={4}
                    className="font-mono text-sm"
                  />
                </div>
              );
            })}
          </div>

          {validationError && (
            <pre
              className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap"
              role="alert"
            >
              {validationError}
            </pre>
          )}

          {conflictError && (
            <div
              className="bg-destructive/10 text-destructive flex flex-col items-start gap-2 rounded-md p-3 text-sm"
              role="alert"
            >
              <p>{conflictError}</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Discard my edits and reload
              </Button>
            </div>
          )}

          <div>
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ProfileDeletionsCard />
    </div>
  );
}
