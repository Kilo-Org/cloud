'use client';

import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitialsFromName } from '@/lib/utils';
import { Mail, Linkedin, Github, Edit } from 'lucide-react';
import { EditProfileDialog } from './EditProfileDialog';

type UserProfileCardProps = {
  name: string;
  email: string;
  imageUrl: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
};

export function UserProfileCard({
  name,
  email,
  imageUrl,
  linkedinUrl,
  githubUrl,
}: UserProfileCardProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  return (
    <>
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-4">
          <Avatar className="h-14 w-14">
            {imageUrl ? <AvatarImage src={imageUrl} alt={name} /> : null}
            <AvatarFallback className="text-xl">
              {getInitialsFromName(name || email)}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h2 className="text-foreground text-xl font-semibold">{name}</h2>
            <p className="text-muted-foreground flex items-center text-sm">
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              {email}
            </p>
            <div className="mt-2 flex flex-col gap-1">
              <ProfileLink
                icon={<Linkedin className="mr-1.5 h-3.5 w-3.5" />}
                url={linkedinUrl}
                label="LinkedIn"
              />
              <ProfileLink
                icon={<Github className="mr-1.5 h-3.5 w-3.5" />}
                url={githubUrl}
                label="GitHub"
              />
            </div>
          </div>
        </div>
        <button
          onClick={() => setEditDialogOpen(true)}
          className="hover:bg-muted inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus:outline-none"
          title="Edit profile"
        >
          <Edit className="text-muted-foreground hover:text-foreground h-4 w-4" />
        </button>
      </div>

      <EditProfileDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        linkedinUrl={linkedinUrl}
        githubUrl={githubUrl}
      />
    </>
  );
}

function ProfileLink({
  icon,
  url,
  label,
}: {
  icon: React.ReactNode;
  url: string | null;
  label: string;
}) {
  const isSafeUrl = url && /^https?:\/\//i.test(url);

  if (!isSafeUrl) {
    return (
      <p className="text-muted-foreground/60 flex items-center text-sm">
        {icon}
        <span>{url ?? `${label} — Not set`}</span>
      </p>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors"
    >
      {icon}
      <span className="truncate">{url}</span>
    </a>
  );
}
