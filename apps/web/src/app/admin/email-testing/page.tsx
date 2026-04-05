'use client';

import { useState, useEffect } from 'react';
import type { TemplateName } from '@/lib/email';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Mail, Send, Eye } from 'lucide-react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { useSession } from 'next-auth/react';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Email Testing</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function EmailTestingPage() {
  const trpc = useTRPC();
  const { data: session } = useSession();

  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string>('');

  const { data: templates } = useQuery(trpc.admin.emailTesting.getTemplates.queryOptions());

  // Pre-fill recipient with logged-in admin's email
  useEffect(() => {
    if (session?.user?.email && !recipient) {
      setRecipient(session.user.email);
    }
  }, [session?.user?.email, recipient]);

  // Auto-select first template on load
  useEffect(() => {
    if (templates && templates.length > 0 && !selectedTemplate) {
      setSelectedTemplate(templates[0].name);
    }
  }, [templates, selectedTemplate]);

  const previewQuery = useQuery(
    trpc.admin.emailTesting.getPreview.queryOptions(
      {
        // Values come directly from the server's getTemplates response,
        // so the cast is safe — tRPC zod will reject anything invalid at runtime anyway.
        template: (selectedTemplate ?? 'orgSubscription') as TemplateName,
      },
      { enabled: selectedTemplate !== null }
    )
  );

  const sendTestMutation = useMutation(trpc.admin.emailTesting.sendTest.mutationOptions());

  const handleSend = () => {
    if (!selectedTemplate || !recipient) return;
    sendTestMutation.mutate(
      {
        template: selectedTemplate as TemplateName,
        recipient,
      },
      {
        onSuccess: result => {
          toast.success(`Test email sent to ${result?.recipient}`);
        },
        onError: error => {
          toast.error(error.message || 'Failed to send test email');
        },
      }
    );
  };

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Email Testing</h2>
          <p className="text-muted-foreground">
            Send test emails and preview template output. Uses hardcoded fixture data.
          </p>
        </div>

        {/* Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Test Email Controls
            </CardTitle>
            <CardDescription>
              Select a template, then send a test email to any address.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="template">Template</Label>
                <Select value={selectedTemplate ?? ''} onValueChange={v => setSelectedTemplate(v)}>
                  <SelectTrigger id="template">
                    <SelectValue placeholder="Select template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates?.map(t => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="recipient">Recipient</Label>
                <Input
                  id="recipient"
                  type="email"
                  placeholder="recipient@example.com"
                  value={recipient}
                  onChange={e => setRecipient(e.target.value)}
                />
              </div>
            </div>

            <Button
              onClick={handleSend}
              disabled={!selectedTemplate || !recipient || sendTestMutation.isPending}
            >
              <Send className="mr-2 h-4 w-4" />
              {sendTestMutation.isPending ? 'Sending...' : 'Send Test Email'}
            </Button>
          </CardContent>
        </Card>

        {/* Preview Pane */}
        {selectedTemplate && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Preview
                {previewQuery.data && (
                  <span className="text-muted-foreground text-sm font-normal">
                    — {previewQuery.data.subject}
                  </span>
                )}
              </CardTitle>
              <CardDescription>Rendered HTML email</CardDescription>
            </CardHeader>
            <CardContent>
              {previewQuery.isPending && (
                <p className="text-muted-foreground text-sm">Loading preview...</p>
              )}
              {previewQuery.data && (
                <iframe
                  srcDoc={previewQuery.data.html}
                  className="h-[600px] w-full rounded-lg border"
                  title="Email preview"
                  sandbox="allow-same-origin"
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AdminPage>
  );
}
