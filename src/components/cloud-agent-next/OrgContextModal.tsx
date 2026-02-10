'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

type OrgContextModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (orgContext: { organizationId: string } | null) => void;
  sessionTitle: string | null;
};

export function OrgContextModal({
  isOpen,
  onClose,
  onConfirm,
  sessionTitle,
}: OrgContextModalProps) {
  const [selected, setSelected] = useState<string>('personal');
  const trpc = useTRPC();

  const { data: organizations, isLoading } = useQuery(
    trpc.organizations.list.queryOptions(undefined, {
      enabled: isOpen,
    })
  );

  const handleConfirm = () => {
    if (selected === 'personal') {
      onConfirm(null);
    } else {
      onConfirm({ organizationId: selected });
    }
  };

  const displayTitle = sessionTitle || 'this session';

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose Context</DialogTitle>
          <DialogDescription>
            Select whether to resume &quot;{displayTitle}&quot; in your personal context or within
            an organization.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        ) : (
          <RadioGroup value={selected} onValueChange={setSelected} className="space-y-3 py-4">
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="personal" id="personal" />
              <Label htmlFor="personal" className="cursor-pointer">
                <div className="flex flex-col">
                  <span className="font-medium">Personal</span>
                  <span className="text-muted-foreground text-xs">Use your personal workspace</span>
                </div>
              </Label>
            </div>

            {organizations?.map(org => (
              <div key={org.organizationId} className="flex items-center space-x-3">
                <RadioGroupItem value={org.organizationId} id={org.organizationId} />
                <Label htmlFor={org.organizationId} className="cursor-pointer">
                  <div className="flex flex-col">
                    <span className="font-medium">{org.organizationName}</span>
                    <span className="text-muted-foreground text-xs capitalize">{org.role}</span>
                  </div>
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isLoading}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
