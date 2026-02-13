'use client';

import { useState } from 'react';
import { Widget } from '@typeform/embed-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const WELCOME_FORM_ID = 'xNTrQO4E';

type WelcomeTypeformModalProps = {
  userEmail: string;
};

export function WelcomeTypeformModal({ userEmail }: WelcomeTypeformModalProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [hasMarkedComplete, setHasMarkedComplete] = useState(false);
  const trpc = useTRPC();

  const markCompleteMutation = useMutation(
    trpc.user.markWelcomeFormCompleted.mutationOptions({
      onSuccess: () => {
        setIsOpen(false);
      },
      onError: error => {
        console.error('Failed to mark welcome form completed:', error);
        setHasMarkedComplete(false);
      },
    })
  );

  const handleComplete = () => {
    if (hasMarkedComplete) return;
    setHasMarkedComplete(true);
    markCompleteMutation.mutate();
  };

  const handleSkip = () => {
    handleComplete();
  };

  if (!isOpen) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) handleSkip();
        setIsOpen(open);
      }}
    >
      <DialogContent
        className="[&>button]:text-muted-foreground [&>button]:hover:bg-muted [&>button]:hover:text-foreground h-[50vh] max-w-[90vw] overflow-hidden p-0 sm:h-[400px] sm:max-w-xl [&>button]:rounded-md [&>button]:p-2"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Welcome to Kilo</DialogTitle>
        <Widget
          id={WELCOME_FORM_ID}
          hidden={{
            email: userEmail,
          }}
          onSubmit={handleComplete}
          onClose={handleSkip}
        />
      </DialogContent>
    </Dialog>
  );
}
