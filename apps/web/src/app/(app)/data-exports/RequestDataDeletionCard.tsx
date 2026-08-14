'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LANDING_URL } from '@/lib/constants';

const SUPPORT_URL = `${LANDING_URL}/support`;

/**
 * Links out to the support form that starts a data deletion request, behind a
 * confirmation that warns the user their export download dies with their data.
 *
 * Deletion is support-mediated: the support form creates a Pylon issue that an
 * agent fulfils manually. That form reads no search params and its category
 * select is uncontrolled, so the category cannot be preselected from a link —
 * the dialog has to name it in copy instead.
 *
 * The confirm action is a real anchor rather than a `useConfirm()` callback: a
 * new tab opened after a promise resolves is no longer attributable to the click
 * gesture, and popup blockers drop it.
 */
export function RequestDataDeletionCard() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request deletion of your data</CardTitle>
        <CardDescription>
          As always, Anaconda offers a process for any user to request deletion of their Kilo
          account and its data.
          <br />
          Data deletion is handled by our support team. Request it from the support form.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <AlertDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline">Request data deletion</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your Kilo data?</AlertDialogTitle>
              {/* Both sentences live inside the description because Radix only
                  wires aria-describedby to it — a sibling paragraph would never
                  be announced when the dialog opens. AlertDialogDescription
                  renders a <p>, so the second sentence is a block span rather
                  than a nested <p>. */}
              <AlertDialogDescription>
                Download your data export before requesting deletion. Once your data is deleted, any
                export download will no longer be available or recoverable.
                <span className="mt-4 block">
                  On the support form, choose the Account Deletion category.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction asChild>
                <a
                  href={SUPPORT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Continue to support form
                  <ExternalLink />
                </a>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
