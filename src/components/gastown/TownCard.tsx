import { Card, CardContent } from '@/components/ui/card';
import { Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type TownCardProps = {
  town: {
    id: string;
    name: string;
    created_at: string;
  };
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
};

export function TownCard({ town, onClick, onDelete }: TownCardProps) {
  return (
    <Card
      className="cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color,transform] hover:bg-white/[0.05]"
      onClick={onClick}
    >
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <h3 className="text-lg font-medium text-white/90">{town.name}</h3>
          <p className="text-sm text-white/50">
            Created {formatDistanceToNow(new Date(town.created_at), { addSuffix: true })}
          </p>
        </div>
        <button
          onClick={onDelete}
          className="rounded p-1.5 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="size-4" />
        </button>
      </CardContent>
    </Card>
  );
}
