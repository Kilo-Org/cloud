import { MessagesSquare } from 'lucide-react';

export default function KiloChatIndexPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <MessagesSquare className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">
          Select a conversation or start a new one
        </p>
      </div>
    </div>
  );
}
