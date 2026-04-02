'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Play,
  RotateCcw,
  Download,
} from 'lucide-react';
import {
  downloadCsv,
  csvField,
  parseCsvToTable,
  extractEmailsFromColumn,
  guessEmailColumn,
  parseEmailList,
  type CsvTableData,
} from '@/lib/admin-csv';
import type { ExtendTrialResult as TrialResult } from '@/routers/admin/extend-claw-trial-router';

type InputMode = 'paste' | 'csv';

function ineligibleReason(status: string | null): string {
  if (status === null) return 'No subscription - must provision first';
  if (status === 'active') return 'Active paid subscription';
  if (status === 'past_due') return 'Past due - active paid subscription';
  if (status === 'unpaid') return 'Unpaid - active paid subscription';
  if (status === 'at_limit') return 'Trial already extends beyond 1 year';
  return `Ineligible status: ${status}`;
}

function subscriptionStatusBadge(status: string | null) {
  if (status === null) return <Badge variant="outline">no subscription</Badge>;
  if (status === 'trialing') return <Badge variant="default">trialing</Badge>;
  if (status === 'canceled') return <Badge variant="secondary">canceled</Badge>;
  if (status === 'at_limit') return <Badge variant="outline">at limit</Badge>;
  return (
    <Badge variant="destructive" title="Cannot modify — active paid subscription">
      {status}
    </Badge>
  );
}

// --- Component ---

const ACTION_CONFIG = {
  extended: { label: 'Extended', icon: Clock, variant: 'default' as const },
  restarted: { label: 'Restarted', icon: RotateCcw, variant: 'secondary' as const },
};

function isEligible(u: { subscriptionStatus: string | null }): boolean {
  return u.subscriptionStatus === 'trialing' || u.subscriptionStatus === 'canceled';
}

export function KiloclawExtendTrial() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Input mode
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [pastedText, setPastedText] = useState('');

  // Step 1: CSV state
  const [csvData, setCsvData] = useState<CsvTableData | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [trialDays, setTrialDays] = useState<string>('7');
  const [isDragging, setIsDragging] = useState(false);

  // Step 2: Match state — null means "not yet submitted"; non-null triggers the query
  const [emailsToMatch, setEmailsToMatch] = useState<string[] | null>(null);

  // Step 3: Results
  const [results, setResults] = useState<TrialResult[] | null>(null);

  // Query — only fires once emailsToMatch is a non-empty array
  const matchUsersQuery = useQuery({
    ...trpc.admin.extendClawTrial.matchUsers.queryOptions({
      emails: emailsToMatch ?? [],
    }),
    enabled: emailsToMatch !== null && emailsToMatch.length > 0,
  });

  const matchedUsers = matchUsersQuery.data?.matched ?? [];
  const unmatchedEmails = matchUsersQuery.data?.unmatched ?? [];
  const hasMatched = matchUsersQuery.isSuccess && emailsToMatch !== null;

  // Toast on match completion — fire once per successful fetch, not on every render.
  // useQuery v5 removed onSuccess from queryOptions, so we track the previous data
  // value in a ref and only toast when it changes to a new non-null result.
  const prevMatchDataRef = useRef(matchUsersQuery.data);
  useEffect(() => {
    if (matchUsersQuery.data === prevMatchDataRef.current) return;
    prevMatchDataRef.current = matchUsersQuery.data;
    if (!matchUsersQuery.data) return;
    const { matched, unmatched } = matchUsersQuery.data;
    if (unmatched.length === 0) {
      toast.success(`All ${matched.length} emails matched to users`);
    } else {
      toast.warning(`Matched ${matched.length} users, ${unmatched.length} emails not found`);
    }
  }, [matchUsersQuery.data]);

  useEffect(() => {
    if (matchUsersQuery.error) {
      toast.error(
        matchUsersQuery.error instanceof Error
          ? matchUsersQuery.error.message
          : 'Failed to match users'
      );
    }
  }, [matchUsersQuery.error]);

  const extendTrialsMutation = useMutation(
    trpc.admin.extendClawTrial.extendTrials.mutationOptions({
      onSuccess: trialResults => {
        setResults(trialResults);
        const successCount = trialResults.filter(r => r.success).length;
        const failCount = trialResults.length - successCount;
        if (failCount === 0) {
          toast.success(`Successfully processed ${successCount} users`);
        } else {
          toast.warning(`Processed ${successCount} users, ${failCount} failed`);
        }
        // Refetch matched users so at_limit status reflects the new trial_ends_at values.
        void queryClient.invalidateQueries(
          trpc.admin.extendClawTrial.matchUsers.queryOptions({ emails: emailsToMatch ?? [] })
        );
      },
      onError: error => {
        toast.error(error.message || 'Failed to extend trials');
      },
    })
  );

  // File handling
  const handleFile = useCallback((file: File) => {
    setResults(null);
    setEmailsToMatch(null);
    const reader = new FileReader();
    reader.onload = e => {
      const text = typeof e.target?.result === 'string' ? e.target.result : '';
      const data = parseCsvToTable(text);
      setCsvData(data);
      const guessed = guessEmailColumn(data.headers, data.rows);
      setSelectedColumn(guessed ?? '');
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const extractedEmails = useMemo(
    () => (csvData && selectedColumn ? extractEmailsFromColumn(csvData.rows, selectedColumn) : []),
    [csvData, selectedColumn]
  );
  const csvEmailCount = extractedEmails.length;

  // Actions
  const handleMatchUsers = () => {
    const emails =
      inputMode === 'csv' && csvData && selectedColumn
        ? extractedEmails
        : parseEmailList(pastedText);

    if (emails.length === 0) {
      toast.error('No valid emails found');
      return;
    }
    if (emails.length > 1000) {
      toast.error(`Too many emails (${emails.length}). Maximum batch size is 1,000.`);
      return;
    }
    setResults(null);
    // Invalidate any cached result before updating state so React Query always
    // issues a fresh network request — even when the email list hasn't changed
    // (e.g. re-match after a "status changed since match" failure).
    void queryClient.invalidateQueries(
      trpc.admin.extendClawTrial.matchUsers.queryOptions({ emails })
    );
    setEmailsToMatch(emails);
  };

  const handleExtendTrials = () => {
    const eligibleEmails = matchedUsers.filter(isEligible).map(u => u.email);
    if (eligibleEmails.length === 0) return;
    const days = Number(trialDays);
    if (!Number.isInteger(days) || days <= 0) {
      toast.error('Please enter a whole number of days');
      return;
    }
    extendTrialsMutation.mutate({
      emails: eligibleEmails,
      trialDays: days,
    });
  };

  const handleClear = () => {
    setCsvData(null);
    setSelectedColumn('');
    setTrialDays('7');
    setPastedText('');
    setEmailsToMatch(null);
    setResults(null);
    setInputMode('paste');
  };

  const handleDownloadResults = (success: boolean) => {
    if (!results) return;
    const filtered = results.filter(r => r.success === success);
    if (filtered.length === 0) {
      toast.info(`No ${success ? 'successful' : 'failed'} results to export`);
      return;
    }
    const content = success
      ? 'email,instance_id,action,new_trial_ends_at\n' +
        filtered
          .map(r =>
            [r.email, r.instanceId ?? '', r.action ?? '', r.newTrialEndsAt ?? '']
              .map(csvField)
              .join(',')
          )
          .join('\n')
      : 'email,user_id,instance_id,error\n' +
        filtered
          .map(r => [r.email, r.userId, r.instanceId ?? '', r.error ?? ''].map(csvField).join(','))
          .join('\n');
    downloadCsv(content, `${success ? 'successful' : 'failed'}-trial-extensions.csv`);
  };

  const handleDownloadIneligible = () => {
    const ineligible = matchedUsers.filter(
      u => u.subscriptionStatus !== 'trialing' && u.subscriptionStatus !== 'canceled'
    );
    if (ineligible.length === 0) {
      toast.info('No ineligible users to export');
      return;
    }
    const content =
      'email,instance_id,stripe_subscription_id,reason\n' +
      ineligible
        .map(u =>
          [
            u.email,
            u.instanceId ?? '',
            u.stripeSubscriptionId ?? '',
            ineligibleReason(u.subscriptionStatus),
          ]
            .map(csvField)
            .join(',')
        )
        .join('\n');
    downloadCsv(content, 'ineligible-users.csv');
  };

  const handleDownloadUnmatched = () => {
    if (unmatchedEmails.length === 0) return;
    const content = 'email\n' + unmatchedEmails.map(u => u.email).join('\n');
    downloadCsv(content, 'unmatched-emails.csv');
  };

  // Computed
  const pastedEmails = useMemo(() => parseEmailList(pastedText), [pastedText]);
  const pastedEmailCount = pastedEmails.length;

  const currentEmailCount = inputMode === 'csv' ? csvEmailCount : pastedEmailCount;

  const eligibleCount = matchedUsers.filter(isEligible).length;

  const ineligibleCount = matchedUsers.length - eligibleCount;

  const canMatch =
    inputMode === 'csv'
      ? selectedColumn && csvEmailCount > 0 && csvEmailCount <= 1000
      : pastedEmailCount > 0 && pastedEmailCount <= 1000;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div>
        <p className="text-muted-foreground text-sm">
          Paste a list of email addresses or upload a CSV to extend or restart KiloClaw trials in
          bulk. Users with active paid subscriptions are skipped automatically.
        </p>
      </div>

      {/* Step 1: Email Input + Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {results ? 'Start New Import' : 'Email Input'}
          </CardTitle>
          {/* Plain <button> tabs instead of the Radix Tabs component: this component
              is itself rendered inside a Radix Tabs panel on the parent page, and nesting
              two Radix Tabs trees breaks controlled state. These buttons only toggle
              inputMode and don't need any Radix behaviour. */}
          <div className="flex gap-1 border-b">
            <button
              type="button"
              onClick={() => setInputMode('paste')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                inputMode === 'paste'
                  ? 'border-b-2 border-current'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Paste list
            </button>
            <button
              type="button"
              onClick={() => setInputMode('csv')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                inputMode === 'csv'
                  ? 'border-b-2 border-current'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Upload CSV
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Input widget — the only thing that changes between tabs */}
          {inputMode === 'paste' ? (
            <div className="space-y-1">
              <Label>Email Addresses</Label>
              <Textarea
                placeholder={'user1@example.com\nuser2@example.com\nuser3@example.com'}
                value={pastedText}
                onChange={e => {
                  setPastedText(e.target.value);
                  setResults(null);
                  setEmailsToMatch(null);
                }}
                rows={6}
                className="font-mono text-sm"
              />
              <p className="text-muted-foreground text-sm">
                One email per line, or separated by commas, semicolons, or spaces.
                {pastedEmailCount > 0 && (
                  <>
                    {' '}
                    <span
                      className={
                        pastedEmailCount > 1000
                          ? 'text-destructive font-medium'
                          : 'text-foreground font-medium'
                      }
                    >
                      {pastedEmailCount} valid email{pastedEmailCount !== 1 ? 's' : ''} detected.
                      {pastedEmailCount > 1000 && ' Exceeds the 1,000 email limit.'}
                    </span>
                  </>
                )}
              </p>
            </div>
          ) : (
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`relative flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
            >
              <FileSpreadsheet className="text-muted-foreground mb-2 h-10 w-10" />
              <p className="text-muted-foreground text-sm">
                {csvData
                  ? csvData.rows.length + ' rows loaded — drop to replace'
                  : 'Drop CSV file here or click to browse'}
              </p>
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={handleInputChange}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>
          )}

          {/* CSV-specific chrome — appears whenever a file is loaded, regardless of active tab */}
          {inputMode === 'csv' && csvData && csvData.headers.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Email Column</Label>
                <Select value={selectedColumn} onValueChange={setSelectedColumn}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select the column containing emails" />
                  </SelectTrigger>
                  <SelectContent>
                    {csvData.headers.map(h => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedColumn && (
                  <p
                    className={`text-sm ${csvEmailCount > 1000 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
                  >
                    {csvEmailCount} valid email{csvEmailCount !== 1 ? 's' : ''} found in &quot;
                    {selectedColumn}&quot;
                    {csvEmailCount > 1000 && ` — exceeds the 1,000 email limit`}
                  </p>
                )}
              </div>

              <div className="max-h-[200px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {csvData.headers.map(h => (
                        <TableHead
                          key={h}
                          className={h === selectedColumn ? 'bg-primary/10 font-semibold' : ''}
                        >
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csvData.rows.slice(0, 5).map((row, i) => (
                      <TableRow key={i}>
                        {csvData.headers.map(h => (
                          <TableCell key={h} className={h === selectedColumn ? 'bg-primary/5' : ''}>
                            {row[h]}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {csvData.rows.length > 5 && (
                <p className="text-muted-foreground text-xs">
                  Showing 5 of {csvData.rows.length} rows
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleMatchUsers} disabled={!canMatch || matchUsersQuery.isFetching}>
              {matchUsersQuery.isFetching ? (
                'Matching...'
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Match {currentEmailCount} Email{currentEmailCount !== 1 ? 's' : ''} to Users
                </>
              )}
            </Button>
            {(pastedText || csvData || hasMatched || results) && (
              <Button variant="outline" onClick={handleClear}>
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step 2: Match Results + Apply */}
      {hasMatched && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Matched Users ({matchedUsers.length})
              {unmatchedEmails.length > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {unmatchedEmails.length} not found
                </Badge>
              )}
              {ineligibleCount > 0 && (
                <Badge variant="outline" className="ml-1">
                  {ineligibleCount} ineligible
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Review the matched users below, set the number of days, then apply. Users with no
              subscription or an active paid plan are skipped automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Eligible users table + apply button */}
            {eligibleCount > 0 ? (
              <div className="space-y-3">
                <div className="max-h-[300px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>User Name</TableHead>
                        <TableHead>Subscription</TableHead>
                        <TableHead>Trial Ends</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchedUsers.filter(isEligible).map(user => (
                        <TableRow key={user.userId}>
                          <TableCell className="font-mono text-sm">{user.email}</TableCell>
                          <TableCell>{user.userName ?? '—'}</TableCell>
                          <TableCell>{subscriptionStatusBadge(user.subscriptionStatus)}</TableCell>
                          <TableCell className="text-sm">
                            {user.trialEndsAt
                              ? new Date(user.trialEndsAt).toLocaleDateString()
                              : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex items-end gap-3">
                  <div className="w-36 space-y-1">
                    <Label htmlFor="trial-days">Days to extend</Label>
                    <Input
                      id="trial-days"
                      type="number"
                      min="1"
                      max="365"
                      step="1"
                      value={trialDays}
                      onChange={e => setTrialDays(e.target.value)}
                      placeholder="7"
                    />
                  </div>
                  <Button
                    onClick={handleExtendTrials}
                    disabled={extendTrialsMutation.isPending || results !== null}
                    size="lg"
                  >
                    {extendTrialsMutation.isPending ? (
                      'Processing...'
                    ) : (
                      <>
                        <Clock className="mr-2 h-4 w-4" />
                        Apply {trialDays}-Day Trial to {eligibleCount} Eligible User
                        {eligibleCount !== 1 ? 's' : ''}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <AlertCircle className="h-4 w-4" />
                No eligible users found.
              </div>
            )}

            {/* Ineligible users table */}
            {ineligibleCount > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">
                    {ineligibleCount} ineligible user{ineligibleCount !== 1 ? 's' : ''}:
                  </p>
                  <Button variant="outline" size="sm" onClick={handleDownloadIneligible}>
                    <Download className="mr-1 h-3 w-3" />
                    Export
                  </Button>
                </div>
                <div className="max-h-[200px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Subscription</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchedUsers
                        .filter(u => !isEligible(u))
                        .map(user => (
                          <TableRow key={user.userId}>
                            <TableCell className="font-mono text-sm">{user.email}</TableCell>
                            <TableCell>
                              {subscriptionStatusBadge(user.subscriptionStatus)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Unmatched emails */}
            {unmatchedEmails.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-destructive text-sm font-medium">
                    {unmatchedEmails.length} email{unmatchedEmails.length !== 1 ? 's' : ''} not
                    found in the database:
                  </p>
                  <Button variant="outline" size="sm" onClick={handleDownloadUnmatched}>
                    <Download className="mr-1 h-3 w-3" />
                    Export
                  </Button>
                </div>
                <div className="bg-muted/50 max-h-[150px] overflow-auto rounded-md border p-3">
                  <div className="flex flex-wrap gap-1">
                    {unmatchedEmails.map(u => (
                      <Badge key={u.email} variant="outline" className="font-mono text-xs">
                        {u.email}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: Results */}
      {results && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              Results
            </CardTitle>
            <CardDescription>
              {results.filter(r => r.success).length} succeeded,{' '}
              {results.filter(r => !r.success).length} failed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Summary stats */}
            <div className="grid grid-cols-2 gap-4">
              {(['extended', 'restarted'] as const).map(action => {
                const count = results.filter(r => r.action === action).length;
                const config = ACTION_CONFIG[action];
                const Icon = config.icon;
                return (
                  <div key={action} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Icon className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium capitalize">{config.label}</span>
                    </div>
                    <p className="mt-1 text-2xl font-bold">{count}</p>
                  </div>
                );
              })}
            </div>

            {/* Full results table */}
            <div className="max-h-[400px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>New Trial End</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result, i) => (
                    <TableRow key={`${result.email}-${i}`}>
                      <TableCell>
                        {result.success ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-600" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{result.email}</TableCell>
                      <TableCell>
                        {result.action ? (
                          <Badge variant={ACTION_CONFIG[result.action].variant}>
                            {result.action}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {result.newTrialEndsAt
                          ? new Date(result.newTrialEndsAt).toLocaleDateString(undefined, {
                              timeZone: 'UTC',
                            })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-destructive text-sm">
                        {result.error ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Export buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownloadResults(true)}
                disabled={results.filter(r => r.success).length === 0}
              >
                <Download className="mr-1 h-3 w-3" />
                Export Successful
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownloadResults(false)}
                disabled={results.filter(r => !r.success).length === 0}
              >
                <Download className="mr-1 h-3 w-3" />
                Export Failed
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
