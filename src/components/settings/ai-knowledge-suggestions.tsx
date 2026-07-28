'use client';

// Review queue for src/lib/ai/learning.ts's findings (migration 060/061)
// — knowledge (or a correction to existing knowledge) the self-learning
// cron noticed in a human agent's WhatsApp reply. Nothing here is live
// until an admin approves it; approving routes through the exact same
// insert-or-update + chunk/embed path as editing a document by hand
// (`PATCH /api/ai/knowledge/suggestions/[id]`), so an approved
// suggestion is indistinguishable from hand-written knowledge.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Check, X, Sparkles, RefreshCw, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  target_document_id: string | null;
  target_document: { title: string; content: string } | null;
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
  const [approvingAll, setApprovingAll] = useState(false);
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

  const approveOrReject = async (id: string, action: 'approve' | 'reject') => {
    const res = await fetch(`/api/ai/knowledge/suggestions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Failed to ${action}`);
    return data as { warning?: string };
  };

  const act = async (id: string, action: 'approve' | 'reject') => {
    setActingOn(id);
    try {
      const data = await approveOrReject(id, action);
      if (data.warning) toast.warning(data.warning);
      else toast.success(action === 'approve' ? 'Knowledge base updated.' : 'Suggestion rejected.');
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActingOn(null);
    }
  };

  // Sequential, not Promise.all — each approval writes to the same
  // knowledge base (chunk delete + insert), so running them in parallel
  // risks racing on a shared document. Slower but safe; the queue is
  // typically a handful of items, not hundreds.
  const approveAll = async () => {
    setApprovingAll(true);
    let succeeded = 0;
    let failed = 0;
    for (const s of suggestions) {
      try {
        await approveOrReject(s.id, 'approve');
        succeeded++;
      } catch {
        failed++;
      }
    }
    await fetchSuggestions();
    setApprovingAll(false);
    if (failed === 0) toast.success(`Approved ${succeeded} suggestion${succeeded === 1 ? '' : 's'}.`);
    else toast.warning(`Approved ${succeeded}, ${failed} failed — still pending.`);
  };

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> Pending suggestions
            </CardTitle>
            <CardDescription>
              Knowledge — or a correction to existing knowledge — your agents&apos; own
              replies taught the assistant. Approve to apply it, or reject if it&apos;s
              wrong or too specific to one customer.
            </CardDescription>
          </div>
          {suggestions.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void approveAll()}
              disabled={approvingAll || actingOn !== null}
              className="shrink-0"
            >
              {approvingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5" />
              )}
              Approve all ({suggestions.length})
            </Button>
          )}
        </div>
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
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{s.title}</p>
                {s.target_document_id ? (
                  <Badge className="border border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-400">
                    <RefreshCw className="mr-1 size-2.5" />
                    Correction to &quot;{s.target_document?.title ?? 'existing document'}&quot;
                  </Badge>
                ) : (
                  <Badge className="border border-primary/30 bg-primary/10 text-[10px] text-primary">
                    New knowledge
                  </Badge>
                )}
              </div>

              {s.target_document_id && s.target_document ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1 rounded-md border border-border bg-background/40 p-2">
                    <p className="text-[10px] uppercase text-muted-foreground">Current</p>
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground line-through decoration-muted-foreground/40">
                      {s.target_document.content}
                    </p>
                  </div>
                  <div className="space-y-1 rounded-md border border-primary/30 bg-primary/5 p-2">
                    <p className="text-[10px] uppercase text-primary">Proposed</p>
                    <p className="whitespace-pre-wrap text-xs text-foreground">{s.content}</p>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{s.content}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void act(s.id, 'reject')}
                  disabled={actingOn === s.id || approvingAll}
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
                  disabled={actingOn === s.id || approvingAll}
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
