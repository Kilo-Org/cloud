'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ExternalLink, Trash2 } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTRPC } from '@/lib/trpc/utils';
import type { UserAdminNote } from '@kilocode/db/schema';
import { formatDate } from '@/lib/admin-utils';
import type { NoteWithAdminUser, UserDetailProps } from '@/types/admin';

export function UserAdminNotes(user: UserDetailProps) {
  const [notes, setNotes] = useState<NoteWithAdminUser[]>(user.admin_notes || []);
  const [noteToDelete, setNoteToDelete] = useState<UserAdminNote | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const router = useRouter();

  const trpc = useTRPC();
  const addNoteMutation = useMutation(
    trpc.admin.users.addNote.mutationOptions({
      onSuccess: (newNote: NoteWithAdminUser) => {
        setNotes(prevNotes => [newNote, ...prevNotes]);
        setNoteContent('');
      },
      onError: (error: unknown) => {
        console.error('Error adding note:', error);
      },
    })
  );

  const deleteNoteMutation = useMutation(
    trpc.admin.users.deleteNote.mutationOptions({
      onSuccess: () => {
        if (noteToDelete) {
          setNotes(prevNotes => prevNotes.filter(note => note.id !== noteToDelete.id));
          setNoteToDelete(null);
        }
      },
      onError: (error: unknown) => {
        console.error('Error deleting note:', error);
      },
    })
  );

  const updateUserMutation = useMutation(
    trpc.admin.users.updateBlockStatus.mutationOptions({
      onSuccess: () => {
        router.refresh(); // Refresh the server-side rendered page
      },
    })
  );

  const handleBlockUser = async () => {
    const blockReason = noteContent.trim();

    try {
      // First create the admin note
      await addNoteMutation.mutateAsync({
        kilo_user_id: user.id,
        noteContent: `User blocked: ${blockReason}`,
      });

      // Then block the user
      await updateUserMutation.mutateAsync({
        userId: user.id,
        blocked_reason: blockReason,
      });

      setNoteContent('');
    } catch (error) {
      console.error('Error blocking user:', error);
    }
  };

  const handleUnblockUser = async () => {
    const unblockNote = noteContent.trim() || 'No reason provided';

    try {
      // First create the admin note
      await addNoteMutation.mutateAsync({
        kilo_user_id: user.id,
        noteContent: `User unblocked: ${unblockNote}`,
      });

      // Then unblock the user
      await updateUserMutation.mutateAsync({
        userId: user.id,
        blocked_reason: null,
      });

      setNoteContent('');
    } catch (error) {
      console.error('Error unblocking user:', error);
    }
  };

  const sortedNotes = useMemo(
    () =>
      [...notes].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [notes]
  );

  return (
    <>
      <Card className="max-h-max lg:col-span-2">
        <CardHeader>
          <CardTitle>Admin Notes</CardTitle>
          <CardDescription>
            Internal notes about this user.
            {user.blocked_reason ? (
              <div className="text-accent-foreground my-1 max-w-max rounded-xl border border-red-500 bg-red-950/50 px-2 py-1">
                {user.blocked_reason}
              </div>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-note">
                {user.blocked_reason
                  ? 'Add a new note or unblock user'
                  : 'Add a new note or block user'}
              </Label>
              <Textarea
                id="new-note"
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                placeholder={
                  user.blocked_reason
                    ? 'Type your note here or provide a reason for unblocking...'
                    : 'Type your note here...'
                }
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    if (!noteContent.trim()) return;
                    addNoteMutation.mutate({ kilo_user_id: user.id, noteContent });
                  }}
                  disabled={addNoteMutation.isPending || !noteContent.trim()}
                  variant="default"
                >
                  {addNoteMutation.isPending ? 'Adding...' : 'Add Note'}
                </Button>
                {user.blocked_reason ? (
                  <Button
                    onClick={handleUnblockUser}
                    disabled={updateUserMutation.isPending || addNoteMutation.isPending}
                    variant="outline"
                  >
                    {updateUserMutation.isPending || addNoteMutation.isPending
                      ? 'Unblocking...'
                      : 'Unblock User'}
                  </Button>
                ) : (
                  <Button
                    onClick={handleBlockUser}
                    disabled={
                      updateUserMutation.isPending ||
                      addNoteMutation.isPending ||
                      !noteContent.trim()
                    }
                    variant="destructive"
                  >
                    {updateUserMutation.isPending || addNoteMutation.isPending
                      ? 'Blocking...'
                      : 'Block User'}
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-4">
              {sortedNotes.map(note => (
                <div key={note.id}>
                  <p className="break-after-auto text-sm break-words whitespace-pre-wrap">
                    {note.note_content.length > 2_000 ? (
                      <>
                        {note.note_content.slice(0, 1000)}
                        <i>
                          <b>{`\n\n...only 2000 of ${note.note_content.length} characters retained...\n\n`}</b>
                        </i>
                        {note.note_content.slice(-1000)}
                      </>
                    ) : (
                      note.note_content
                    )}
                  </p>
                  <div className="text-muted-foreground flex flex-row items-center justify-between text-xs">
                    By {note.admin_kilo_user?.google_user_name || 'Unknown Admin'} on{' '}
                    {formatDate(note.created_at)}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const blob = new Blob([note.note_content], {
                          type: 'text/plain;charset=utf-8',
                        });
                        const url = URL.createObjectURL(blob);
                        window.open(url, '_blank', 'noopener');
                        setTimeout(() => URL.revokeObjectURL(url), 0);
                      }}
                      aria-label="Open note in new tab"
                      className="ml-auto"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNoteToDelete(note)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Delete Note Confirmation Dialog */}
      <Dialog open={!!noteToDelete} onOpenChange={() => setNoteToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the note.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteToDelete(null)}>
              Cancel
            </Button>
            {noteToDelete && (
              <Button
                variant="destructive"
                onClick={() => deleteNoteMutation.mutate({ note_id: noteToDelete.id })}
                disabled={deleteNoteMutation.isPending}
              >
                {deleteNoteMutation.isPending ? 'Deleting...' : 'Yes, delete it'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
