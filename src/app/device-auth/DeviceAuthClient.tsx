'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, XCircle, Loader2, Shield } from 'lucide-react';

type DeviceAuthClientProps = {
  code: string;
};

export function DeviceAuthClient({ code }: DeviceAuthClientProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleAuthorize = async (approved: boolean) => {
    setStatus('loading');
    setErrorMessage('');

    if (approved) {
      // Approve: POST to /api/device-auth/tokens
      const response = await fetch('/api/device-auth/tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const data = await response.json();
        setStatus('error');
        setErrorMessage(data.error || 'Failed to authorize device');
        return;
      }
    } else {
      // Deny: DELETE to /api/device-auth/codes/:code
      const response = await fetch(`/api/device-auth/codes/${code}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        setStatus('error');
        setErrorMessage(data.error || 'Failed to deny device');
        return;
      }
    }
    setStatus('success');
  };

  if (status === 'success') {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
              <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
            </div>
            <CardTitle>Authorization Successful</CardTitle>
            <CardDescription>You can now close this window</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === 'error' && errorMessage) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
              <XCircle className="h-10 w-10 text-red-600 dark:text-red-400" />
            </div>
            <CardTitle>Authorization Failed</CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="bg-primary/10 mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full">
            <Shield className="text-primary h-10 w-10" />
          </div>
          <CardTitle>Authorize Device</CardTitle>
          <CardDescription>A device is requesting access to your Kilo account</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-center">
              <div className="text-muted-foreground mb-2 text-sm font-medium">
                Verification Code
              </div>
              <div className="text-2xl font-bold tracking-wider">{code}</div>
            </AlertDescription>
          </Alert>

          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-sm font-medium">This will allow the device to:</p>
            <ul className="text-muted-foreground space-y-1 text-sm">
              <li>• Access your organizations</li>
              <li>• Make API requests on your behalf</li>
              <li>• Use AI models</li>
            </ul>
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleAuthorize(false)}
              disabled={status === 'loading'}
            >
              Deny
            </Button>
            <Button
              className="flex-1"
              onClick={() => handleAuthorize(true)}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Authorizing...
                </>
              ) : (
                'Authorize'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
