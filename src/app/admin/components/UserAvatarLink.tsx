import Link from 'next/link';
import type { User } from '@kilocode/db/schema';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitialsFromName } from '@/lib/utils';

type UserAvatarLinkProps = {
  user: Pick<User, 'id' | 'google_user_name' | 'google_user_image_url' | 'google_user_email'>;
  className?: string;
  avatarClassName?: string;
  nameClassName?: string;
  displayFormat?: 'name' | 'email-name';
};

export function UserAvatarLink({
  user,
  className = 'flex h-full w-full items-center space-x-3 px-4 py-3',
  avatarClassName = 'h-8 w-8 shrink-0',
  nameClassName = '',
  displayFormat = 'name',
}: UserAvatarLinkProps) {
  const userDetailUrl = `/admin/users/${encodeURIComponent(user.id)}`;

  const displayText =
    displayFormat === 'email-name'
      ? `${user.google_user_email} (${user.google_user_name})`
      : user.google_user_name;

  return (
    <Link href={userDetailUrl} className={className}>
      <Avatar className={avatarClassName}>
        <AvatarImage src={user.google_user_image_url} alt={user.google_user_name} />
        <AvatarFallback>{getInitialsFromName(user.google_user_name)}</AvatarFallback>
      </Avatar>
      <span className={nameClassName}>{displayText}</span>
    </Link>
  );
}
