'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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

// --- Types ---

type CsvData = {
  headers: string[];
  rows: Record<string, string>[];
};

type TrialResult = {
  email: string;
  userId: string;
  instanceId: string | null;
  success: boolean;
  action?: 'extended' | 'restarted';
  newTrialEndsAt?: string;
  trialDays?: number;
  error?: string;
};

type InputMode = 'paste' | 'csv';

// --- CSV Parsing ---

function parseCsvToTable(text: string): CsvData {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          parts.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    parts.push(current.trim());
    return parts;
  };

  const headers = parseLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

function extractEmails(rows: Record<string, string>[], column: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const row of rows) {
    const val = (row[column] ?? '').toLowerCase().trim();
    if (val && val.includes('@') && val.includes('.') && !seen.has(val)) {
      seen.add(val);
      emails.push(val);
    }
  }
  return emails;
}

function guessEmailColumn(headers: string[], rows: Record<string, string>[]): string | null {
  const emailHeader = headers.find(h => h.toLowerCase().trim() === 'email');
  if (emailHeader) return emailHeader;

  let bestCol: string | null = null;
  let bestCount = 0;
  for (const h of headers) {
    let count = 0;
    for (const row of rows) {
      const val = (row[h] ?? '').trim();
      if (val.includes('@') && val.includes('.')) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestCol = h;
    }
  }
  return bestCount > 0 ? bestCol : null;
}

function parseEmailList(text: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  // Split on newlines, commas, semicolons, spaces, and tabs
  const parts = text.split(/[\n,;\s]+/);
  for (const part of parts) {
    // Strip surrounding quotes, angle brackets, and whitespace
    const val = part
      .replace(/^[<"'\s]+|[>"'\s]+$/g, '')
      .toLowerCase()
      .trim();
    if (val && val.includes('@') && val.includes('.') && !seen.has(val)) {
      seen.add(val);
      emails.push(val);
    }
  }
  return emails;
}

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function ineligibleReason(status: string | null): string {
  if (status === null) return 'No subscription - must provision first';
  if (status === 'active') return 'Active paid subscription';
  if (status === 'past_due') return 'Past due - active paid subscription';
  if (status === 'unpaid') return 'Unpaid - active paid subscription';
  return `Ineligible status: ${status}`;
}

function subscriptionStatusBadge(status: string | null) {
  if (status === null) return <Badge variant="outline">no subscription</Badge>;
  if (status === 'trialing') return <Badge variant="default">trialing</Badge>;
  if (status === 'canceled') return <Badge variant="secondary">canceled</Badge>;
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

export function KiloclawExtendTrial() {
  const trpc = useTRPC();

  // Input mode
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [pastedText, setPastedText] = useState('');

  // Step 1: CSV state
  const [csvData, setCsvData] = useState<CsvData | null>(null);
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

  // Toast on match completion (fire once per successful fetch)
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

  // Actions
  const handleMatchUsers = () => {
    // If a CSV is loaded and a column selected, use it; otherwise fall back to paste text.
    const emails =
      csvData && selectedColumn
        ? extractEmails(csvData.rows, selectedColumn)
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
    setEmailsToMatch(emails);
  };

  const handleExtendTrials = () => {
    const eligibleEmails = matchedUsers
      .filter(u => u.subscriptionStatus === 'trialing' || u.subscriptionStatus === 'canceled')
      .map(u => u.email);
    if (eligibleEmails.length === 0) return;
    const days = parseInt(trialDays, 10);
    if (isNaN(days) || days <= 0) {
      toast.error('Please enter a valid number of days');
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
          .map(r => `${r.email},${r.instanceId ?? ''},${r.action ?? ''},${r.newTrialEndsAt ?? ''}`)
          .join('\n')
      : 'email,error\n' + filtered.map(r => `${r.email},${r.error ?? ''}`).join('\n');
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
        .map(
          u =>
            `${u.email},${u.instanceId ?? ''},${u.stripeSubscriptionId ?? ''},${ineligibleReason(u.subscriptionStatus)}`
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
  const pastedEmails = parseEmailList(pastedText);
  const pastedEmailCount = pastedEmails.length;

  const extractedEmails =
    csvData && selectedColumn ? extractEmails(csvData.rows, selectedColumn) : [];
  const csvEmailCount = extractedEmails.length;

  const currentEmailCount = csvData && selectedColumn ? csvEmailCount : pastedEmailCount;

  const eligibleCount = matchedUsers.filter(
    u => u.subscriptionStatus === 'trialing' || u.subscriptionStatus === 'canceled'
  ).length;

  const ineligibleCount = matchedUsers.length - eligibleCount;

  // CSV takes precedence when loaded; fall back to paste text count
  const canMatch = csvData
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
          {/* Tab switcher — only swaps the input widget, everything else stays */}
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
          {csvData && csvData.headers.length > 0 && (
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

          {/* Trial days + action buttons — always visible */}
          <div className="flex items-end gap-4">
            <div className="w-40 space-y-1">
              <Label>Trial Days</Label>
              <Input
                type="number"
                min="1"
                max="365"
                value={trialDays}
                onChange={e => setTrialDays(e.target.value)}
                placeholder="7"
              />
            </div>
          </div>

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
              {trialDays}-day trial will be extended or restarted for trialing/canceled users. Users
              with no subscription or an active paid plan are skipped.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {matchedUsers.length > 0 ? (
              <>
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
                      {matchedUsers.map(user => (
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

                <Button
                  onClick={handleExtendTrials}
                  disabled={
                    extendTrialsMutation.isPending || eligibleCount === 0 || results !== null
                  }
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
              </>
            ) : (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <AlertCircle className="h-4 w-4" />
                No matching users found in the database.
              </div>
            )}

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
                    <TableHead>Days</TableHead>
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
                      <TableCell>{result.trialDays ?? '—'}</TableCell>
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
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadIneligible}
                disabled={ineligibleCount === 0}
              >
                <Download className="mr-1 h-3 w-3" />
                Export Ineligible
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
