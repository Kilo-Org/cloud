'use client';

import { Button } from '@/components/ui/button';
import { SidebarFooter } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@radix-ui/react-avatar';
import { LogOut } from 'lucide-react';
import { signOut } from 'next-auth/react';

type User = {
  google_user_name: string;
  google_user_email: string;
  google_user_image_url: string;
};

type SidebarUserFooterProps = {
  user: User | null | undefined;
  isLoading: boolean;
};

export default function SidebarUserFooter({ user, isLoading }: SidebarUserFooterProps) {
  const handleLogout = async () => {
    await signOut({ callbackUrl: '/' });
  };

  // Get user initials for avatar fallback
  const getUserInitials = (name: string) => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <SidebarFooter className="p-4">
      {isLoading ? (
        <div className="flex items-center gap-3 p-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="mb-1 h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-8 w-8" />
        </div>
      ) : user ? (
        <div className="flex items-center gap-3 p-2">
          <Avatar className="h-8 w-8 overflow-hidden rounded-full">
            <AvatarImage
              src={user.google_user_image_url}
              alt={user.google_user_name}
              className="h-full w-full object-cover"
            />
            <AvatarFallback className="bg-muted flex h-full w-full items-center justify-center text-sm font-medium">
              {getUserInitials(user.google_user_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.google_user_name}</p>
            <p className="text-muted-foreground truncate text-xs">{user.google_user_email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleLogout}
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </SidebarFooter>
  );
}
