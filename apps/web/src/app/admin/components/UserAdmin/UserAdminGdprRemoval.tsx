'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import type { UserDetailProps } from '@/types/admin';

export function UserAdminGdprRemoval(user: UserDetailProps) {
  const router = useRouter();
  const [isProcessingGdprRequest, setIsProcessingGdprRequest] = useState(false);
  const [showGdprConfirmDialog, setShowGdprConfirmDialog] = useState(false);
  const [hasReadHandbook, setHasReadHandbook] = useState(false);

  const handleGdprButtonClick = () => {
    setShowGdprConfirmDialog(true);
  };

  const handleGdprDataRemoval = async () => {
    setShowGdprConfirmDialog(false);
    setIsProcessingGdprRequest(true);

    const response = await fetch('/admin/api/users/gdpr-removal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: user.id }),
    });

    const result = await response.json();

    if (response.ok) {
      console.log('GDPR data removal completed:', result.message);
      // Redirect back to users list since this user no longer exists
      router.push('/admin/users');
    } else {
      console.error('GDPR data removal failed:', result.error);
    }

    setIsProcessingGdprRequest(false);
  };

  const handleCancelGdprRequest = () => {
    setShowGdprConfirmDialog(false);
  };

  return (
    <>
      {/* GDPR Data Removal Card */}
      <Card className="max-h-max border-red-800 bg-red-950/50 lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-200">
            <AlertTriangle />
            GDPR Data Removal
          </CardTitle>
          <CardDescription className="text-red-300">
            This action is irreversible and will permanently delete all data associated with this
            user. Note: This will NOT delete all data - additional manual steps are required as
            outlined in our handbook.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="rounded-md border border-blue-800 bg-blue-950/50 p-3">
              <p className="mb-2 text-sm text-blue-200">
                <strong>Important:</strong> Before proceeding, you must read the GDPR removal
                process in our handbook.
              </p>
              <ViewGdprHandbookLink />
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="handbook-confirmation"
                checked={hasReadHandbook}
                onChange={e => setHasReadHandbook(e.target.checked)}
                className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-red-400 focus:ring-red-400"
              />
              <Label htmlFor="handbook-confirmation" className="text-sm">
                I have read and understand the GDPR removal process in the handbook
              </Label>
            </div>

            <Button
              variant="destructive"
              onClick={handleGdprButtonClick}
              disabled={isProcessingGdprRequest || !hasReadHandbook}
            >
              {isProcessingGdprRequest ? 'Processing...' : 'Request Data Removal'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* GDPR Confirmation Dialog */}
      <Dialog open={showGdprConfirmDialog} onOpenChange={setShowGdprConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-200">
              <AlertTriangle />
              Confirm GDPR Data Removal
            </DialogTitle>
            <DialogDescription>
              <div className="mb-4">
                Are you absolutely sure you want to permanently delete all data for{' '}
                <strong>{user.google_user_email}</strong>? This includes their account, usage data,
                and any other associated information. This action cannot be undone.
              </div>
              <div>
                Be sure to follow the handbook for other data: <ViewGdprHandbookLink />
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleCancelGdprRequest}
              disabled={isProcessingGdprRequest}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleGdprDataRemoval}
              disabled={isProcessingGdprRequest}
            >
              {isProcessingGdprRequest ? 'Deleting...' : 'Yes, I understand. Delete most data.'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ViewGdprHandbookLink() {
  return (
    <a
      href="https://docs.google.com/document/d/159ded7GLQpnw0SA02k8GmkOmf5AHMO09OTn4HRW4tUo/edit?tab=t.uuovqlbwb0d#heading=h.ffmi335edibb"
      target="_blank"
      className="inline-flex items-center gap-1 text-sm text-blue-600 underline hover:text-blue-300"
    >
      View GDPR Removal Handbook
      <ExternalLink size={14} />
    </a>
  );
}
