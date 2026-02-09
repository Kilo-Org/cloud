'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
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
import { toast } from 'sonner';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
  DollarSign,
  Calendar,
  Users,
} from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

type MatchedUser = {
  email: string;
  userId: string;
  userName: string | null;
};

type UnmatchedEmail = {
  email: string;
};

type CreditResult = {
  email: string;
  userId: string;
  success: boolean;
  error?: string;
};

function parseCsvEmails(text: string): { emails: string[]; skippedLines: string[] } {
  const lines = text.trim().split('\n');
  const emails: string[] = [];
  const skippedLines: string[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Skip header row if it looks like one
    if (i === 0 && line.toLowerCase().includes('email')) {
      continue;
    }

    // Handle CSV with multiple columns - take first column or find email column
    const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
    const email = parts.find(p => p.includes('@')) || parts[0];

    // Basic email validation
    if (!email || !email.includes('@') || !email.includes('.')) {
      skippedLines.push(`Line ${i + 1}: Invalid email "${line}"`);
      continue;
    }

    const normalizedEmail = email.toLowerCase();
    if (seenEmails.has(normalizedEmail)) {
      skippedLines.push(`Line ${i + 1}: Duplicate email "${email}"`);
      continue;
    }

    seenEmails.add(normalizedEmail);
    emails.push(normalizedEmail);
  }

  return { emails, skippedLines };
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

function generateEmailsCsv(emails: string[]): string {
  return 'email\n' + emails.join('\n');
}

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Bulk Credits</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function BulkCreditsPage() {
  const trpc = useTRPC();

  // CSV upload state
  const [isDragging, setIsDragging] = useState(false);
  const [parsedEmails, setParsedEmails] = useState<string[]>([]);
  const [skippedLines, setSkippedLines] = useState<string[]>([]);

  // User matching state
  const [matchedUsers, setMatchedUsers] = useState<MatchedUser[]>([]);
  const [unmatchedEmails, setUnmatchedEmails] = useState<UnmatchedEmail[]>([]);
  const [hasMatched, setHasMatched] = useState(false);

  // Credit form state
  const [amountUsd, setAmountUsd] = useState<string>('');
  const [expirationDate, setExpirationDate] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  // Results state
  const [creditResults, setCreditResults] = useState<CreditResult[] | null>(null);

  const matchUsersMutation = useMutation(
    trpc.admin.bulkUserCredits.matchUsers.mutationOptions({
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

  const grantCreditsMutation = useMutation(
    trpc.admin.bulkUserCredits.grantBulkCredits.mutationOptions({
      onSuccess: results => {
        setCreditResults(results);
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        if (failCount === 0) {
          toast.success(`Successfully added credits to ${successCount} accounts`);
        } else {
          toast.warning(`Added credits to ${successCount} accounts, ${failCount} failed`);
        }
      },
      onError: error => {
        toast.error(error.message || 'Failed to grant credits');
      },
    })
  );

  const handleFile = useCallback((file: File) => {
    setCreditResults(null);
    setHasMatched(false);
    setMatchedUsers([]);
    setUnmatchedEmails([]);
    const reader = new FileReader();
    reader.onload = e => {
      const text = typeof e.target?.result === 'string' ? e.target.result : '';
      const { emails, skippedLines: skipped } = parseCsvEmails(text);
      setParsedEmails(emails);
      setSkippedLines(skipped);
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

  const handleMatchUsers = () => {
    if (parsedEmails.length === 0) return;
    matchUsersMutation.mutate({ emails: parsedEmails });
  };

  const handleGrantCredits = () => {
    if (matchedUsers.length === 0) return;
    const amount = parseFloat(amountUsd);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid credit amount');
      return;
    }

    grantCreditsMutation.mutate({
      emails: matchedUsers.map(u => u.email),
      amountUsd: amount,
      expirationDate: expirationDate || undefined,
      description: description || undefined,
    });
  };

  const handleClear = () => {
    setParsedEmails([]);
    setSkippedLines([]);
    setMatchedUsers([]);
    setUnmatchedEmails([]);
    setHasMatched(false);
    setCreditResults(null);
    setAmountUsd('');
    setExpirationDate('');
    setDescription('');
  };

  const handleDownloadSuccessful = () => {
    if (!creditResults) return;
    const successfulEmails = creditResults.filter(r => r.success).map(r => r.email);
    if (successfulEmails.length === 0) {
      toast.error('No successful credits to export');
      return;
    }
    const csvContent = generateEmailsCsv(successfulEmails);
    downloadCsv(csvContent, 'successful-credits.csv');
  };

  const handleDownloadFailed = () => {
    if (!creditResults) return;
    const failedEmails = creditResults.filter(r => !r.success).map(r => r.email);
    if (failedEmails.length === 0) {
      toast.info('No failed credits to export');
      return;
    }
    const csvContent = generateEmailsCsv(failedEmails);
    downloadCsv(csvContent, 'failed-credits.csv');
  };

  const handleDownloadUnmatched = () => {
    if (unmatchedEmails.length === 0) return;
    const csvContent = generateEmailsCsv(unmatchedEmails.map(u => u.email));
    downloadCsv(csvContent, 'unmatched-emails.csv');
  };

  const isFormValid = matchedUsers.length > 0 && parseFloat(amountUsd) > 0;

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Bulk User Credits</h2>
          <p className="text-muted-foreground">
            Import a CSV of email addresses to grant credits to multiple personal Kilo accounts at
            once.
          </p>
        </div>

        {/* CSV Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              CSV Import
            </CardTitle>
            <CardDescription>
              Upload a CSV file with email addresses. The file should have one email per line or a
              column containing emails.
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

            {/* Skipped lines warning */}
            {skippedLines.length > 0 && (
              <div className="border-destructive/50 bg-destructive/10 rounded-lg border p-4">
                <p className="text-destructive mb-2 flex items-center gap-2 font-medium">
                  <AlertCircle className="h-4 w-4" />
                  Skipped lines ({skippedLines.length})
                </p>
                <ul className="text-muted-foreground list-disc pl-5 text-sm">
                  {skippedLines.slice(0, 5).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                  {skippedLines.length > 5 && <li>...and {skippedLines.length - 5} more</li>}
                </ul>
              </div>
            )}

            {/* Parsed emails preview */}
            {parsedEmails.length > 0 && !hasMatched && (
              <div className="space-y-4">
                <p className="text-sm font-medium">
                  Found {parsedEmails.length} email{parsedEmails.length !== 1 ? 's' : ''} in CSV
                </p>
                <div className="max-h-[200px] overflow-auto rounded-lg border p-4">
                  <ul className="text-muted-foreground space-y-1 text-sm">
                    {parsedEmails.slice(0, 10).map((email, i) => (
                      <li key={i} className="font-mono">
                        {email}
                      </li>
                    ))}
                    {parsedEmails.length > 10 && (
                      <li className="text-muted-foreground/70">
                        ...and {parsedEmails.length - 10} more
                      </li>
                    )}
                  </ul>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleMatchUsers} disabled={matchUsersMutation.isPending}>
                    {matchUsersMutation.isPending
                      ? 'Matching...'
                      : `Match ${parsedEmails.length} Emails to Users`}
                  </Button>
                  <Button variant="outline" onClick={handleClear}>
                    Clear
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Matched Users Section */}
        {hasMatched && !creditResults && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Matched Users ({matchedUsers.length})
              </CardTitle>
              <CardDescription>
                {unmatchedEmails.length > 0
                  ? `${unmatchedEmails.length} email${unmatchedEmails.length !== 1 ? 's' : ''} could not be matched to existing accounts.`
                  : 'All emails matched to existing Kilo accounts.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Unmatched emails warning */}
              {unmatchedEmails.length > 0 && (
                <div className="border-destructive/50 bg-destructive/10 rounded-lg border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-destructive flex items-center gap-2 font-medium">
                      <XCircle className="h-4 w-4" />
                      Unmatched emails ({unmatchedEmails.length})
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDownloadUnmatched}
                      className="text-destructive border-destructive/50 hover:bg-destructive/10"
                    >
                      <Download className="mr-1 h-4 w-4" />
                      Download Unmatched
                    </Button>
                  </div>
                  <ul className="text-muted-foreground list-disc pl-5 text-sm">
                    {unmatchedEmails.slice(0, 5).map((item, i) => (
                      <li key={i} className="font-mono">
                        {item.email}
                      </li>
                    ))}
                    {unmatchedEmails.length > 5 && (
                      <li>...and {unmatchedEmails.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Matched users table */}
              {matchedUsers.length > 0 && (
                <div className="max-h-[300px] overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>User ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchedUsers.map((user, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-sm">{user.email}</TableCell>
                          <TableCell>{user.userName || '—'}</TableCell>
                          <TableCell>
                            <Link
                              href={`/admin/users/${user.userId}`}
                              className="font-mono text-sm text-blue-400 hover:underline"
                            >
                              {user.userId.slice(0, 8)}...
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Credit allocation form */}
              {matchedUsers.length > 0 && (
                <div className="space-y-4 rounded-lg border p-4">
                  <h3 className="flex items-center gap-2 font-medium">
                    <DollarSign className="h-4 w-4" />
                    Credit Allocation
                  </h3>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <Label htmlFor="amount">Amount (USD) *</Label>
                      <Input
                        id="amount"
                        type="number"
                        placeholder="Enter amount"
                        value={amountUsd}
                        onChange={e => setAmountUsd(e.target.value)}
                        min="0.01"
                        step="0.01"
                      />
                    </div>
                    <div>
                      <Label htmlFor="expiration" className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Expiration Date
                      </Label>
                      <Input
                        id="expiration"
                        type="date"
                        value={expirationDate}
                        onChange={e => setExpirationDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="description">Description</Label>
                      <Input
                        id="description"
                        type="text"
                        placeholder="Optional description"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleGrantCredits}
                      disabled={!isFormValid || grantCreditsMutation.isPending}
                    >
                      {grantCreditsMutation.isPending
                        ? 'Sending Credits...'
                        : `Send Credits to ${matchedUsers.length} Users`}
                    </Button>
                    <Button variant="outline" onClick={handleClear}>
                      Clear & Start Over
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Results Section */}
        {creditResults && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Credit Results
              </CardTitle>
              <CardDescription>
                Successfully added credits to {creditResults.filter(r => r.success).length} of{' '}
                {creditResults.length} accounts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Export buttons */}
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleDownloadSuccessful}>
                  <Download className="mr-1 h-4 w-4" />
                  Export Successful ({creditResults.filter(r => r.success).length})
                </Button>
                {creditResults.some(r => !r.success) && (
                  <Button variant="outline" onClick={handleDownloadFailed}>
                    <Download className="mr-1 h-4 w-4" />
                    Export Failed ({creditResults.filter(r => !r.success).length})
                  </Button>
                )}
              </div>

              {/* Results table */}
              <div className="max-h-[400px] overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>User ID</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditResults.map((result, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          {result.success ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                          ) : (
                            <XCircle className="text-destructive h-5 w-5" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{result.email}</TableCell>
                        <TableCell>
                          {result.userId ? (
                            <Link
                              href={`/admin/users/${result.userId}`}
                              className="font-mono text-sm text-blue-400 hover:underline"
                            >
                              {result.userId.slice(0, 8)}...
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-destructive text-sm">
                          {result.error || ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <Button variant="outline" onClick={handleClear}>
                Clear & Upload New
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminPage>
  );
}
