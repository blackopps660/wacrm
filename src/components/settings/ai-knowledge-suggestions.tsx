'use client';

// Review queue for src/lib/ai/learning.ts's findings (migration 060) —
// knowledge the self-learning cron noticed in a human agent's WhatsApp
// reply that the knowledge base doesn't cover yet. Nothing here is
// live until an admin approves it; approving routes through the exact
// same insert + chunk/embed path as adding a document by hand
// (`PATCH /api/ai/knowledge/suggestions/[id]`), so an approved
// suggestion is indistinguishable from hand-written knowledge.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Check, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

interface Suggestion {
  id: string;
  title: string;
  content: string;
  conversation_id: string | null;
  created_at: string;
}

export function AiKnowledgeSuggestionsCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge/suggestions');
      const data = await res.json();
      if (res.ok) setSuggestions(data.suggestions ?? []);
      else toast.error(data.error ?? 'Failed to load suggestions');
    } catch {
      toast.error('Failed to load suggestions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchSuggestions();
  }, [accountId, fetchSuggestions]);

  const act = async (id: string, action: 'approve' | 'reject') => {
    setActingOn(id);
    try {
      const res = await fetch(`/api/ai/knowledge/suggestions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Failed to ${action}`);
        return;
      }
      if (data.warning) toast.warning(data.warning);
      else toast.success(action === 'approve' ? 'Added to knowledge base.' : 'Suggestion rejected.');
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      toast.error(`Failed to ${action}`);
    } finally {
      setActingOn(null);
    }
  };

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" /> Pending suggestions
        </CardTitle>
        <CardDescription>
          Knowledge your agents&apos; own replies taught the assistant. Approve to
          add it to the knowledge base above, or reject if it&apos;s wrong or too
          specific to one customer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending suggestions right now.</p>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium text-foreground">{s.title}</p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {s.content}
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void act(s.id, 'reject')}
                  disabled={actingOn === s.id}
                  className="text-destructive hover:text-destructive"
                >
                  {actingOn === s.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => void act(s.id, 'approve')}
                  disabled={actingOn === s.id}
                >
                  {actingOn === s.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Approve
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
