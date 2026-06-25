'use client';

import { useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CostInsightsOwner } from '../types';

export function AskKiloInput({
  owner,
  onSubmit,
}: {
  owner: CostInsightsOwner;
  onSubmit?: (question: string) => void;
}) {
  const [question, setQuestion] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;

    onSubmit?.(trimmedQuestion);
    setQuestion('');
  }

  return (
    <form onSubmit={handleSubmit} className="relative">
      <Label htmlFor="ask-kilo-question" className="sr-only">
        Ask Kilo about spending for {owner.name}
      </Label>
      <Input
        id="ask-kilo-question"
        value={question}
        onChange={event => setQuestion(event.target.value)}
        placeholder="Ask Kilo about your spending"
        className="bg-card h-12! rounded-xl pr-14"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!question.trim()}
        aria-label="Ask Kilo"
        className="absolute top-1.5 right-1.5"
      >
        <Send className="size-4" aria-hidden="true" />
      </Button>
    </form>
  );
}
