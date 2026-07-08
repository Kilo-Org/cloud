'use client';

import { SidebarFooter } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarImage, AvatarFallback } from '@radix-ui/react-avatar';
import { BookOpen, ChevronsUpDown, Download, LogOut, UserCog } from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';

type User = {
  google_user_name: string;
  google_user_email: string;
  google_user_image_url: string;
};

type SidebarUserFooterProps = {
  user: User | null | undefined;
  isLoading: boolean;
};

// Get user initials for avatar fallback
function getUserInitials(name: string) {
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export default function SidebarUserFooter({ user, isLoading }: SidebarUserFooterProps) {
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/revoke-web-session', { method: 'POST' });
    } finally {
      await signOut({ callbackUrl: '/' });
    }
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
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-3 rounded-md p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar className="bg-surface-overlay h-8 w-8 overflow-hidden rounded-full border border-border text-foreground">
              <AvatarImage
                src={user.google_user_image_url}
                alt={user.google_user_name}
                className="h-full w-full object-cover"
              />
              <AvatarFallback className="bg-surface-overlay flex h-full w-full items-center justify-center text-sm font-medium">
                {getUserInitials(user.google_user_name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.google_user_name}</p>
              <p className="text-muted-foreground truncate text-xs">{user.google_user_email}</p>
            </div>
            <ChevronsUpDown className="text-muted-foreground h-4 w-4 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56"
            align="start"
            side="top"
            sideOffset={4}
          >
            <DropdownMenuItem onClick={() => router.push('/connected-accounts')}>
              <UserCog className="h-4 w-4" />
              Connected Accounts
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/install')}>
              <Download className="h-4 w-4" />
              Install
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/learn')}>
              <BookOpen className="h-4 w-4" />
              Learn
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </SidebarFooter>
  );
}
