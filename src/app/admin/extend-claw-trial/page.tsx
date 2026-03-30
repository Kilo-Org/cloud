'use client';

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

// --- Types ---

type CsvData = {
  headers: string[];
  rows: Record<string, string>[];
};

type MatchedUser = {
  email: string;
  userId: string;
  userName: string | null;
  subscriptionStatus: string | null;
};

type UnmatchedEmail = {
  email: string;
};

type TrialResult = {
  email: string;
  userId: string;
  success: boolean;
  action?: 'extended' | 'restarted';
  newTrialEndsAt?: string;
  trialDays?: number;
  error?: string;
};

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

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Extend Claw Trial</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

const ACTION_CONFIG = {
  extended: { label: 'Extended', icon: Clock, variant: 'default' as const },
  restarted: { label: 'Restarted', icon: RotateCcw, variant: 'secondary' as const },
};

export default function ExtendClawTrialPage() {
  const trpc = useTRPC();

  // Step 1: CSV state
  const [csvData, setCsvData] = useState<CsvData | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [trialDays, setTrialDays] = useState<string>('7');
  const [isDragging, setIsDragging] = useState(false);

  // Step 2: Match state
  const [matchedUsers, setMatchedUsers] = useState<MatchedUser[]>([]);
  const [unmatchedEmails, setUnmatchedEmails] = useState<UnmatchedEmail[]>([]);
  const [hasMatched, setHasMatched] = useState(false);

  // Step 3: Results
  const [results, setResults] = useState<TrialResult[] | null>(null);

  // Mutations
  const matchUsersMutation = useMutation(
    trpc.admin.extendClawTrial.matchUsers.mutationOptions({
      onSuccess: result => {
        setMatchedUsers(result.matched);
        setUnmatchedEmails(result.unmatched);
        setHasMatched(true);
        if (result.unmatched.length === 0) {
          toast.success(`All ${result.matched.length} emails matched to users`);
        } else {
          toast.warning(
            `Matched ${result.matched.length} users, ${result.unmatched.length} emails not found`
          );
        }
      },
      onError: error => {
        toast.error(error.message || 'Failed to match users');
      },
    })
  );

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
    setHasMatched(false);
    setMatchedUsers([]);
    setUnmatchedEmails([]);
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
    if (!csvData || !selectedColumn) return;
    const emails = extractEmails(csvData.rows, selectedColumn);
    if (emails.length === 0) {
      toast.error('No valid emails found in the selected column');
      return;
    }
    matchUsersMutation.mutate({ emails });
  };

  const handleExtendTrials = () => {
    if (matchedUsers.length === 0) return;
    const days = parseInt(trialDays, 10);
    if (isNaN(days) || days <= 0) {
      toast.error('Please enter a valid number of days');
      return;
    }
    extendTrialsMutation.mutate({
      emails: matchedUsers.map(u => u.email),
      trialDays: days,
    });
  };

  const handleClear = () => {
    setCsvData(null);
    setSelectedColumn('');
    setTrialDays('7');
    setMatchedUsers([]);
    setUnmatchedEmails([]);
    setHasMatched(false);
    setResults(null);
  };

  const handleDownloadResults = (success: boolean) => {
    if (!results) return;
    const filtered = results.filter(r => r.success === success);
    if (filtered.length === 0) {
      toast.info(`No ${success ? 'successful' : 'failed'} results to export`);
      return;
    }
    const content =
      'email,action,new_trial_ends_at\n' +
      filtered.map(r => `${r.email},${r.action ?? ''},${r.newTrialEndsAt ?? ''}`).join('\n');
    downloadCsv(content, `${success ? 'successful' : 'failed'}-trial-extensions.csv`);
  };

  // Computed
  const extractedEmails =
    csvData && selectedColumn ? extractEmails(csvData.rows, selectedColumn) : [];
  const parsedEmailCount = extractedEmails.length;

  const eligibleCount = matchedUsers.filter(
    u => u.subscriptionStatus === 'trialing' || u.subscriptionStatus === 'canceled'
  ).length;

  // Users that will be skipped: active paid plans or no subscription yet
  const ineligibleCount = matchedUsers.length - eligibleCount;

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Extend KiloClaw Trial</h2>
          <p className="text-muted-foreground">
            Import a CSV of email addresses to extend or restart KiloClaw trials in bulk. Users with
            active paid subscriptions are skipped automatically.
          </p>
        </div>

        {/* Step 1: CSV Upload + Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              {results ? 'Start New Import' : 'CSV Import'}
            </CardTitle>
            <CardDescription>
              Upload a CSV file. You&apos;ll select which column contains the email addresses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`relative flex min-h-[150px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
            >
              <FileSpreadsheet className="text-muted-foreground mb-2 h-10 w-10" />
              <p className="text-muted-foreground text-sm">Drop CSV file here or click to browse</p>
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={handleInputChange}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>

            {csvData && csvData.headers.length > 0 && (
              <div className="space-y-4">
                {/* Column selector */}
                <div className="flex items-end gap-4">
                  <div className="flex-1 space-y-2">
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
                      <p className="text-muted-foreground text-sm">
                        {parsedEmailCount} valid email{parsedEmailCount !== 1 ? 's' : ''} found in
                        &quot;{selectedColumn}&quot;
                      </p>
                    )}
                  </div>

                  {/* Days input */}
                  <div className="w-40 space-y-2">
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

                {/* CSV preview table */}
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
                            <TableCell
                              key={h}
                              className={h === selectedColumn ? 'bg-primary/5' : ''}
                            >
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

                {/* Match button */}
                <div className="flex gap-2">
                  <Button
                    onClick={handleMatchUsers}
                    disabled={
                      !selectedColumn || parsedEmailCount === 0 || matchUsersMutation.isPending
                    }
                  >
                    {matchUsersMutation.isPending ? (
                      'Matching...'
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Match {parsedEmailCount} Email{parsedEmailCount !== 1 ? 's' : ''} to Users
                      </>
                    )}
                  </Button>
                  {(csvData || hasMatched || results) && (
                    <Button variant="outline" onClick={handleClear}>
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            )}
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
                {trialDays}-day trial will be extended or restarted for trialing/canceled users.
                Users with no subscription or an active paid plan are skipped.
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
                          <TableHead>User ID</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {matchedUsers.map(user => (
                          <TableRow key={user.userId}>
                            <TableCell className="font-mono text-sm">{user.email}</TableCell>
                            <TableCell>{user.userName ?? '—'}</TableCell>
                            <TableCell>{subscriptionStatusBadge(user.subscriptionStatus)}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {user.userId}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <Button
                    onClick={handleExtendTrials}
                    disabled={extendTrialsMutation.isPending || eligibleCount === 0}
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
                    <p className="text-sm font-medium text-destructive">
                      {unmatchedEmails.length} email{unmatchedEmails.length !== 1 ? 's' : ''} not
                      found in the database:
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const csv = 'email\n' + unmatchedEmails.map(u => u.email).join('\n');
                        downloadCsv(csv, 'unmatched-emails.csv');
                      }}
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Export
                    </Button>
                  </div>
                  <div className="max-h-[150px] overflow-auto rounded-md border bg-muted/50 p-3">
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
                            ? new Date(result.newTrialEndsAt).toLocaleDateString()
                            : '—'}
                        </TableCell>
                        <TableCell>{result.trialDays ?? '—'}</TableCell>
                        <TableCell className="text-sm text-destructive">
                          {result.error ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Export buttons */}
              <div className="flex gap-2">
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
    </AdminPage>
  );
}
