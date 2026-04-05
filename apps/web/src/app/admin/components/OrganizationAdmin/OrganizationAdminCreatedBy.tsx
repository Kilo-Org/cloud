'use client';

import { useState, useEffect, useRef } from 'react';
import { useAdminOrganizationDetails } from '@/app/admin/api/organizations/hooks';
import { useSearchUsers } from '@/app/admin/api/users/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Loader2, Search, Edit, User } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import Link from 'next/link';

type User = {
  id: string;
  google_user_email: string;
  google_user_name: string | null;
};

type OrganizationAdminCreatedByProps = {
  organizationId: string;
};

export function OrganizationAdminCreatedBy({ organizationId }: OrganizationAdminCreatedByProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const { data: organization } = useAdminOrganizationDetails(organizationId);

  // Search users query - only enabled when there's a search term
  const searchUsersQuery = useSearchUsers(debouncedSearchTerm);
  const filteredSearchResults = searchUsersQuery.data?.users || [];

  // Mutation to update created_by_kilo_user_id
  const updateCreatedByMutation = useMutation(
    trpc.organizations.admin.updateCreatedBy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void queryClient.invalidateQueries({
          queryKey: ['admin-organization-details', organizationId],
        });
      },
    })
  );

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

  const handleUpdateCreatedBy = () => {
    if (!selectedUser) {
      toast.error('Please select a user from the search results');
      return;
    }

    updateCreatedByMutation.mutate(
      { organizationId, userId: selectedUser.id },
      {
        onSuccess: () => {
          toast.success('Created by user updated successfully');
          setOpen(false);
          handleReset();
        },
        onError: error => {
          toast.error(error.message || 'Failed to update created by user');
        },
      }
    );
  };

  const handleClearCreatedBy = () => {
    updateCreatedByMutation.mutate(
      { organizationId, userId: null },
      {
        onSuccess: () => {
          toast.success('Created by user cleared successfully');
          setOpen(false);
          handleReset();
        },
        onError: error => {
          toast.error(error.message || 'Failed to clear created by user');
        },
      }
    );
  };

  const handleReset = () => {
    setEmail('');
    setSelectedUser(null);
    setDebouncedSearchTerm('');
  };

  const handleOpen = () => {
    setOpen(true);
    // Pre-populate with current user if set
    if (organization?.created_by_kilo_user_id && organization?.created_by_user_email) {
      const currentUser: User = {
        id: organization.created_by_kilo_user_id,
        google_user_email: organization.created_by_user_email,
        google_user_name: organization.created_by_user_name,
      };
      setSelectedUser(currentUser);
      setEmail(organization.created_by_user_email);
    }
  };

  const handleClose = () => {
    setOpen(false);
    handleReset();
  };

  if (!organization) {
    return null;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Created By
          </CardTitle>
          <CardDescription>The user who originally created this organization</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              {organization.created_by_kilo_user_id ? (
                <div className="space-y-1">
                  <Link
                    href={`/admin/users/${encodeURIComponent(organization.created_by_kilo_user_id)}`}
                    target="_blank"
                    className="cursor-pointer hover:text-blue-600"
                  >
                    {organization.created_by_user_email}
                  </Link>
                  {organization.created_by_user_name && (
                    <p className="text-muted-foreground text-sm">
                      {organization.created_by_user_name}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">Not set</p>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleOpen}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Update Created By User</DialogTitle>
            <DialogDescription>
              Search for an existing user by email or kilo user ID to set as the creator of this
              organization.
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
                  placeholder="Enter user email or kilo user ID..."
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
                          <div className="text-muted-foreground text-xs">
                            {user.google_user_name}
                          </div>
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
          </div>

          <DialogFooter className="flex justify-between">
            <div>
              {organization.created_by_kilo_user_id && (
                <Button
                  variant="outline"
                  onClick={handleClearCreatedBy}
                  disabled={updateCreatedByMutation.isPending}
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={updateCreatedByMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpdateCreatedBy}
                disabled={!selectedUser || updateCreatedByMutation.isPending}
              >
                {updateCreatedByMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Update
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
