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
import { DATA_DELETION_COPY, DATA_DELETION_SUPPORT_PATH } from './data-deletion-request';

const SUPPORT_URL = `${LANDING_URL}${DATA_DELETION_SUPPORT_PATH}`;

/**
 * Links out to the support form that starts a data deletion request, behind a
 * confirmation that warns the user their export download dies with their data.
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
        <CardTitle>{DATA_DELETION_COPY.cardTitle}</CardTitle>
        <CardDescription>{DATA_DELETION_COPY.cardDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <AlertDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline">{DATA_DELETION_COPY.triggerLabel}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{DATA_DELETION_COPY.dialogTitle}</AlertDialogTitle>
              {/* AlertDialogDescription renders a <p>, so the instruction below
                  has to be a sibling rather than nested inside it. */}
              <AlertDialogDescription>
                {DATA_DELETION_COPY.dialogDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="text-muted-foreground text-sm">{DATA_DELETION_COPY.dialogInstruction}</p>
            <AlertDialogFooter>
              <AlertDialogCancel>{DATA_DELETION_COPY.cancelLabel}</AlertDialogCancel>
              <AlertDialogAction asChild>
                <a
                  href={SUPPORT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsDialogOpen(false)}
                >
                  {DATA_DELETION_COPY.confirmLabel}
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
