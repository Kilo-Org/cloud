'use client';
import { useAwsComputeAccess } from '@/hooks/useAwsComputeAccess';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useAwsComputeData } from '@/hooks/useAwsComputeData';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function AwsComputeSettings({ organizationId }: { organizationId?: string }) {
  const hasAccess = useAwsComputeAccess({ organizationId, enabled: true });
  if (!hasAccess) return null;
  return <AwsComputeForm key={organizationId ?? 'personal'} organizationId={organizationId} />;
}
function AwsComputeForm({ organizationId }: { organizationId?: string }) {
  const id = useId();
  const [accountId, setAccountId] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [accountTouched, setAccountTouched] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const data = useAwsComputeData(organizationId);
  const status = data.status.data;
  const busy =
    data.prepare.isPending ||
    data.instructions.isPending ||
    data.validate.isPending ||
    data.discard.isPending;
  const enrolled = data.enrollment.data?.enrolled === true;
  const error = [data.prepare, data.instructions, data.validate, data.discard].sort(
    (a, b) => b.submittedAt - a.submittedAt
  )[0]?.error;
  const validAccount = /^\d{12}$/.test(accountId.trim());
  const accountError = accountTouched && !validAccount ? 'Enter a 12-digit AWS account ID.' : null;
  const candidate = data.instructions.data;
  const launch =
    status?.state === 'pending' &&
    candidate?.stackName === status.stackName &&
    candidate.accountId === status.accountId
      ? candidate
      : undefined;
  const [expiredLaunchUrl, setExpiredLaunchUrl] = useState<string | null>(null);
  const launchExpired = launch ? expiredLaunchUrl === launch.launchUrl : false;
  // The signed template link expires. Re-render at expiry so the browser never offers a stale link.
  const launchUrl = launch?.launchUrl;
  const launchExpiresAt = launch?.expiresAt;
  useEffect(() => {
    if (!launchUrl || !launchExpiresAt) return;
    const timer = setTimeout(
      () => setExpiredLaunchUrl(launchUrl),
      Math.max(0, Date.parse(launchExpiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [launchUrl, launchExpiresAt]);

  async function prepare(event: FormEvent) {
    event.preventDefault();
    setAccountTouched(true);
    if (!validAccount) return;
    try {
      await data.prepare.mutateAsync(accountId.trim());
      await data.instructions.mutateAsync();
    } catch {
      /* The mutation displays the fixed server error. */
    }
  }
  async function validate(event: FormEvent) {
    event.preventDefault();
    const value = status?.state === 'ready' ? status.roleArn : roleArn.trim();
    if (value) data.validate.mutate(value);
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle role="heading" aria-level={2}>
            AWS compute
          </CardTitle>
          <Badge variant="secondary">
            {status?.state === 'ready' ? 'Connected' : status ? 'Setup pending' : 'Not connected'}
          </Badge>
        </div>
        <CardDescription>
          Run each sandbox on a private EC2 instance with 2 vCPUs and 8 GiB of memory in US East (N.
          Virginia).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.status.isPending || data.enrollment.isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading AWS settings…
          </p>
        ) : data.status.isError || data.enrollment.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              AWS settings could not be loaded.
              <Button
                className="min-h-11 sm:min-h-9"
                variant="outline"
                size="sm"
                onClick={() => {
                  void data.status.refetch();
                  void data.enrollment.refetch();
                }}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription id={`${id}-error`}>{error.message}</AlertDescription>
              </Alert>
            )}
            {!enrolled && (
              <p className="text-muted-foreground text-sm">
                {status
                  ? 'This connection remains saved. Contact Kilo to enable AWS compute.'
                  : 'AWS compute is not enabled. Contact Kilo.'}
              </p>
            )}
            {status?.state === 'ready' ? (
              <>
                <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="min-h-11 font-mono sm:min-h-9">{status.accountId}</dd>
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="min-w-0 font-mono break-all">{status.roleArn}</dd>
                  <dt className="text-muted-foreground">Release</dt>
                  <dd>Template {status.templateVersion}</dd>
                  <dt className="text-muted-foreground">Last checked</dt>
                  <dd>{new Date(status.lastVerifiedAt).toLocaleString()}</dd>
                </dl>
                <form onSubmit={validate} className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-11 sm:min-h-9"
                    variant="outline"
                    disabled={busy || !enrolled}
                    type="submit"
                  >
                    {data.validate.isPending && <Loader2 className="size-4 animate-spin" />}Check
                    connection
                  </Button>
                  <Button className="min-h-11 sm:min-h-9" asChild variant="ghost">
                    <a
                      href={`https://${status.region}.console.aws.amazon.com/cloudformation/home?region=${status.region}#/stacks/stackinfo?stackId=${encodeURIComponent(status.stackId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open AWS stack
                      <ExternalLink className="size-4" />
                    </a>
                  </Button>
                </form>
                {data.validate.isSuccess && (
                  <p role="status" className="text-muted-foreground text-sm">
                    Connection check passed.
                  </p>
                )}
              </>
            ) : status?.state === 'pending' ? (
              <>
                <p className="text-sm">
                  Account <span className="min-h-11 font-mono sm:min-h-9">{status.accountId}</span>{' '}
                  · Template {status.templateVersion}
                </p>
                <p className="text-muted-foreground text-sm break-all">
                  Stack: <span className="min-h-11 font-mono sm:min-h-9">{status.stackName}</span>
                </p>
                <p className="text-muted-foreground text-sm">
                  Launch the stack with an AWS identity that can create every resource in the
                  template, including IAM roles. Wait for completion, then copy its
                  ControllerRoleArn output.
                </p>
                <div className="flex flex-wrap gap-2">
                  {launch && !launchExpired ? (
                    <Button className="min-h-11 sm:min-h-9" asChild variant="outline">
                      <a href={launch.launchUrl} target="_blank" rel="noopener noreferrer">
                        Launch stack
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ) : (
                    <Button
                      className="min-h-11 sm:min-h-9"
                      variant="outline"
                      disabled={busy || !enrolled}
                      onClick={() => data.instructions.mutate()}
                    >
                      {data.instructions.isPending && <Loader2 className="size-4 animate-spin" />}
                      Prepare launch link
                    </Button>
                  )}
                  {launch && (
                    <Button
                      className="min-h-11 sm:min-h-9"
                      variant="ghost"
                      disabled={busy || !enrolled}
                      onClick={() => data.instructions.mutate()}
                    >
                      Refresh link
                    </Button>
                  )}
                </div>
                <form onSubmit={validate} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-role`}>Role ARN</Label>
                    <Input
                      id={`${id}-role`}
                      className="min-h-11 font-mono sm:min-h-9"
                      value={roleArn}
                      onChange={event => {
                        setRoleArn(event.target.value);
                        data.validate.reset();
                      }}
                      autoComplete="off"
                      placeholder="arn:aws:iam::123456789012:role/…"
                      required
                      disabled={busy || !enrolled}
                      aria-describedby={error ? `${id}-error` : undefined}
                    />
                  </div>
                  <Button
                    className="min-h-11 sm:min-h-9"
                    type="submit"
                    disabled={busy || !enrolled || !roleArn.trim()}
                  >
                    {data.validate.isPending && <Loader2 className="size-4 animate-spin" />}Validate
                    connection
                  </Button>
                </form>
                <Button
                  className="min-h-11 sm:min-h-9"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDiscardOpen(true)}
                >
                  Discard setup
                </Button>
                <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Discard AWS setup?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes the saved setup draft. Any AWS stack remains in your account.
                        Delete unused resources in AWS.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        disabled={data.discard.isPending}
                        onClick={() =>
                          data.discard.mutate(status.generation, {
                            onSettled: () => setDiscardOpen(false),
                          })
                        }
                      >
                        Discard setup
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : enrolled && data.enrollment.data?.available ? (
              <form onSubmit={prepare} className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  Enter the AWS account enabled for this preview. You need permission to create the
                  stack resources, including IAM roles.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-account`}>AWS account ID</Label>
                  <Input
                    id={`${id}-account`}
                    className="min-h-11 sm:min-h-9"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={12}
                    value={accountId}
                    onChange={event => {
                      setAccountId(event.target.value);
                      data.prepare.reset();
                    }}
                    onBlur={() => setAccountTouched(true)}
                    placeholder="123456789012"
                    disabled={busy}
                    required
                    aria-invalid={Boolean(accountError)}
                    aria-describedby={accountError ? `${id}-account-error` : undefined}
                  />
                  {accountError && (
                    <p id={`${id}-account-error`} className="text-destructive text-sm">
                      {accountError}
                    </p>
                  )}
                </div>
                <Button className="min-h-11 sm:min-h-9" type="submit" disabled={busy}>
                  {data.prepare.isPending && <Loader2 className="size-4 animate-spin" />}Prepare AWS
                  stack
                </Button>
              </form>
            ) : (
              enrolled && (
                <p className="text-muted-foreground text-sm">
                  AWS setup is unavailable. Try again later.
                </p>
              )
            )}
            <p className="text-muted-foreground text-xs">
              Cloud Agent keeps your workspace disk when the instance stops. When enabled, workspace
              snapshots can restore files if Cloud Agent replaces the disk.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
