'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useAdminRequestById } from '@/app/admin/api/requests/hooks';

type RequestDetailDialogProps = {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function statusCodeVariant(code: number | null): 'default' | 'secondary' | 'destructive' {
  if (code === null) return 'secondary';
  if (code >= 200 && code < 300) return 'default';
  if (code >= 400 && code < 500) return 'secondary';
  return 'destructive';
}

function statusCodeLabel(code: number | null): string {
  if (code === null) return 'N/A';
  return String(code);
}

export function RequestDetailDialog({ requestId, open, onOpenChange }: RequestDetailDialogProps) {
  const [tab, setTab] = useState('overview');
  const { data: item, isLoading } = useAdminRequestById(requestId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request Detail {requestId ? `#${requestId}` : ''}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Loading...</div>
        ) : !item ? (
          <div className="py-8 text-center text-muted-foreground">Request not found</div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="raw">Raw JSON</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-muted-foreground text-xs font-medium">ID</div>
                  <div className="font-mono text-sm">{item.id}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">Created At</div>
                  <div className="text-sm">{item.created_at}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">User ID</div>
                  <div className="font-mono text-sm">{item.kilo_user_id ?? 'N/A'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">Organization ID</div>
                  <div className="font-mono text-sm">{item.organization_id ?? 'N/A'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">Provider</div>
                  <div className="text-sm">{item.provider ?? 'N/A'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">Model</div>
                  <div className="text-sm">{item.model ?? 'N/A'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs font-medium">Status Code</div>
                  <Badge variant={statusCodeVariant(item.status_code)}>
                    {statusCodeLabel(item.status_code)}
                  </Badge>
                </div>
              </div>

              {item.request !== null && item.request !== undefined && (
                <div>
                  <div className="text-muted-foreground text-xs font-medium mb-1">Request Body</div>
                  <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto max-h-60">
                    {JSON.stringify(item.request, null, 2)}
                  </pre>
                </div>
              )}

              {item.response !== null && item.response !== undefined && (
                <div>
                  <div className="text-muted-foreground text-xs font-medium mb-1">Response</div>
                  <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto max-h-60">
                    {item.response}
                  </pre>
                </div>
              )}
            </TabsContent>

            <TabsContent value="raw" className="pt-4">
              <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto max-h-[60vh]">
                {JSON.stringify(item, null, 2)}
              </pre>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
