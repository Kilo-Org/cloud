// src/components/BigLoader.tsx

import { Loader2Icon } from 'lucide-react';

type BigLoaderProps = {
  title: string;
};

export default function BigLoader({ title }: BigLoaderProps) {
  return (
    <div
      className="relative flex flex-col items-center justify-center gap-8"
      role="status"
      aria-busy="true"
    >
      <h1 className="text-foreground text-3xl font-bold sm:text-gray-200">{title}</h1>
      <div className="relative">
        <Loader2Icon className="h-32 w-32 animate-spin text-blue-400" />
        <div className="absolute inset-0 h-32 w-32 animate-ping rounded-full bg-blue-400 opacity-20"></div>
      </div>
    </div>
  );
}
