'use client';

import { useState, useEffect, useRef } from 'react';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useAddMember } from '@/app/admin/api/organizations/hooks';
import { useSearchUsers } from '@/app/admin/api/users/hooks';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

type User = {
  id: string;
  google_user_email: string;
  google_user_name: string | null;
};

type AddMemberDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onMemberAdded: () => void;
};

export function AddMemberDialog({
  open,
  onOpenChange,
  organizationId,
  onMemberAdded,
}: AddMemberDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('member');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const currentMembers = organizationData?.members || [];

  // Search users query - only enabled when there's a search term
  const searchUsersQuery = useSearchUsers(debouncedSearchTerm);

  // Filter search results to exclude current members
  const filteredSearchResults = searchUsersQuery.data?.users
    ? (() => {
        const currentMemberEmails = new Set(currentMembers.map(member => member.email));
        return searchUsersQuery.data.users.filter(
          user => !currentMemberEmails.has(user.google_user_email)
        );
      })()
    : [];

  const addMemberMutation = useAddMember(organizationId);

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setSelectedUser(null);

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      setDebouncedSearchTerm(value);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const handleUserSelect = (user: User) => {
    setSelectedUser(user);
    setEmail(user.google_user_email);
    setDebouncedSearchTerm(''); // Clear search results
  };

  const handleAddMember = () => {
    if (!selectedUser) {
      toast.error('Please select a user from the search results');
      return;
    }

    addMemberMutation.mutate(
      {
        organizationId,
        userId: selectedUser.id,
        role,
      },
      {
        onSuccess: () => {
          toast.success('Member added successfully');
          onMemberAdded();
          onOpenChange(false);
          handleReset();
        },
        onError: error => {
          toast.error(error.message || 'Failed to add member');
        },
      }
    );
  };

  const handleReset = () => {
    setEmail('');
    setRole('member');
    setSelectedUser(null);
    setDebouncedSearchTerm('');
  };

  const handleClose = () => {
    onOpenChange(false);
    handleReset();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Member</DialogTitle>
          <DialogDescription>
            Search for an existing user by email and assign them a role in this organization.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="email">User Email</Label>
            <div className="relative">
              <Input
                id="email"
                type="text"
                autoComplete="off"
                placeholder="Enter user email..."
                value={email}
                onChange={e => handleEmailChange(e.target.value)}
                className="pr-10"
              />
              {searchUsersQuery.isFetching && (
                <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
              )}
              {!searchUsersQuery.isFetching && email && (
                <Search className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2" />
              )}
            </div>

            {/* Search Results */}
            {filteredSearchResults.length > 0 && (
              <div className="relative z-100 mt-1 w-full">
                <div className="bg-popover absolute max-h-40 overflow-y-auto rounded-md border shadow-lg">
                  {filteredSearchResults.map(user => (
                    <button
                      key={user.id}
                      type="button"
                      className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground w-full px-3 py-2 text-left text-sm focus:outline-none"
                      onClick={() => handleUserSelect(user)}
                    >
                      <div className="font-medium">{user.google_user_email}</div>
                      {user.google_user_name && (
                        <div className="text-muted-foreground text-xs">{user.google_user_name}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedUser && (
              <div className="bg-muted/50 rounded-md border p-2 text-sm">
                <div className="font-medium text-green-600">
                  ✓ Selected: {selectedUser.google_user_email}
                </div>
                {selectedUser.google_user_name && (
                  <div className="text-muted-foreground text-xs">
                    {selectedUser.google_user_name}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(value: OrganizationRole) => setRole(value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="billing_manager">Billing Manager</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={addMemberMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleAddMember} disabled={!selectedUser || addMemberMutation.isPending}>
            {addMemberMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add Member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
