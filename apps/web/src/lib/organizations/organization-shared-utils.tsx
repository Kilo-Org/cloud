import { Crown, User } from 'lucide-react';

export const getRoleIcon = (role: string) => {
  switch (role) {
    case 'owner':
      return <Crown className="h-4 w-4 text-yellow-600" />;
    case 'member':
      return <User className="text-muted-foreground h-4 w-4" />;
    default:
      return <User className="text-muted-foreground h-4 w-4" />;
  }
};

export const getRoleBadgeVariant = (role: string) => {
  switch (role) {
    case 'owner':
      return 'secondary-outline' as const;
    case 'member':
      return 'outline' as const;
    default:
      return 'outline' as const;
  }
};

export const getRoleLabel = (role: string) => {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'member':
      return 'Member';
    default:
      return 'Member';
  }
};
