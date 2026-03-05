'use client';

import { useState, useEffect } from 'react';
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

type TemplateName =
  | 'orgSubscription'
  | 'orgRenewed'
  | 'orgCancelled'
  | 'orgSSOUserJoined'
  | 'orgInvitation'
  | 'magicLink'
  | 'balanceAlert'
  | 'autoTopUpFailed'
  | 'ossInviteNewUser'
  | 'ossInviteExistingUser'
  | 'ossExistingOrgProvisioned'
  | 'deployFailed';

type ProviderName = 'customerio';

export default function EmailTestingPage() {
  const trpc = useTRPC();
  const { data: session } = useSession();

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateName | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(null);
  const [recipient, setRecipient] = useState<string>('');

  const { data: templates } = useQuery(trpc.admin.emailTesting.getTemplates.queryOptions());
  const { data: providers } = useQuery(trpc.admin.emailTesting.getProviders.queryOptions());

  // Pre-fill recipient with logged-in admin's email
  useEffect(() => {
    if (session?.user?.email && !recipient) {
      setRecipient(session.user.email);
    }
  }, [session?.user?.email, recipient]);

  // Auto-select first template and provider on load
  useEffect(() => {
    if (templates && templates.length > 0 && !selectedTemplate) {
      setSelectedTemplate(templates[0].name as TemplateName);
    }
  }, [templates, selectedTemplate]);

  useEffect(() => {
    if (providers && providers.length > 0 && !selectedProvider) {
      setSelectedProvider(providers[0] as ProviderName);
    }
  }, [providers, selectedProvider]);

  const previewEnabled = selectedTemplate !== null && selectedProvider !== null;
  const previewQuery = useQuery(
    trpc.admin.emailTesting.getPreview.queryOptions(
      {
        template: selectedTemplate ?? 'orgSubscription',
        provider: selectedProvider ?? 'customerio',
      },
      { enabled: previewEnabled }
    )
  );

  const sendTestMutation = useMutation(trpc.admin.emailTesting.sendTest.mutationOptions());

  const handleSend = () => {
    if (!selectedTemplate || !selectedProvider || !recipient) return;
    sendTestMutation.mutate(
      { template: selectedTemplate, provider: selectedProvider, recipient },
      {
        onSuccess: result => {
          toast.success(`Test email sent via ${result.provider} to ${result.recipient}`);
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
              Select a template and provider, then send a test email to any address.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="template">Template</Label>
                <Select
                  value={selectedTemplate ?? ''}
                  onValueChange={v => setSelectedTemplate(v as TemplateName)}
                >
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
                <Label htmlFor="provider">Provider</Label>
                <Select
                  value={selectedProvider ?? ''}
                  onValueChange={v => setSelectedProvider(v as ProviderName)}
                >
                  <SelectTrigger id="provider">
                    <SelectValue placeholder="Select provider..." />
                  </SelectTrigger>
                  <SelectContent>
                    {providers?.map(p => (
                      <SelectItem key={p} value={p}>
                        {p}
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
              disabled={
                !selectedTemplate || !selectedProvider || !recipient || sendTestMutation.isPending
              }
            >
              <Send className="mr-2 h-4 w-4" />
              {sendTestMutation.isPending ? 'Sending...' : 'Send Test Email'}
            </Button>
          </CardContent>
        </Card>

        {/* Preview Pane */}
        {selectedTemplate && selectedProvider && (
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
              <CardDescription>
                {selectedProvider === 'customerio'
                  ? 'Variables that will be sent to the Customer.io API'
                  : 'Rendered HTML email'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {previewQuery.isPending && (
                <p className="text-muted-foreground text-sm">Loading preview...</p>
              )}
              {previewQuery.data?.type === 'customerio' && (
                <div className="rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-muted-foreground px-4 py-2 text-left font-medium">
                          Variable
                        </th>
                        <th className="text-muted-foreground px-4 py-2 text-left font-medium">
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(previewQuery.data.message_data).map(([key, value]) => (
                        <tr key={key} className="border-b last:border-0">
                          <td className="px-4 py-2 font-mono text-xs">{key}</td>
                          <td className="px-4 py-2 font-mono text-xs break-all">{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {previewQuery.data?.type === 'mailgun' && (
                <iframe
                  srcDoc={previewQuery.data.html}
                  title="Email preview"
                  className="h-[600px] w-full rounded-lg border bg-white"
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
