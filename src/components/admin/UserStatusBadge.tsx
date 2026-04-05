import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { UserTableProps } from '@/types/admin';

type UserStatusBadgeProps = {
  is_detail: boolean;
  user: UserTableProps;
};

export function UserStatusBadge({ user, is_detail }: UserStatusBadgeProps) {
  const net_block_reason =
    user.blocked_reason ??
    (user.is_blacklisted_by_domain ? 'User email domain is blacklisted' : null);
  if (net_block_reason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <Badge
              variant="destructive"
              className={cn('block truncate', is_detail ? 'max-w-64 text-xl' : 'max-w-32')}
            >
              {is_detail ? net_block_reason : 'blocked'}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{net_block_reason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (user.is_admin) {
    return <Badge variant="default">Admin</Badge>;
  }

  return null; // No badge for regular users
}
