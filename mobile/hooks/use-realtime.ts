import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Message, Conversation } from '../lib/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Ported from src/hooks/use-realtime.ts (web) — Supabase Realtime is
// plain websocket via the JS SDK, portable to Expo with zero backend
// changes (messages/conversations are already in the
// supabase_realtime publication). Only the client import differs.

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  /** Postgres row filter (e.g. `conversation_id=eq.<id>`) — scopes the
   * subscription server-side instead of receiving every row in the
   * table and discarding most of them client-side. Always pass this
   * when watching a single conversation/thread. */
  messagesFilter?: string;
  conversationsFilter?: string;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  messagesFilter,
  conversationsFilter,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    // Neither handler passed — nothing to subscribe to.
    if (!onMessageRef.current && !onConversationRef.current) return;

    let channel = supabase.channel(channelName);

    // Only subscribe to a table when a caller actually handles it —
    // e.g. the thread screen only cares about `messages`, so it never
    // needs to receive (and discard) every `conversations` row change
    // in the account.
    if (onMessageRef.current) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          ...(messagesFilter ? { filter: messagesFilter } : {}),
        },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>['eventType'],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        },
      );
    }

    if (onConversationRef.current) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations',
          ...(conversationsFilter ? { filter: conversationsFilter } : {}),
        },
        (payload) => {
          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Conversation>['eventType'],
            new: payload.new as Conversation,
            old: payload.old as Partial<Conversation>,
          });
        },
      );
    }

    channel.subscribe((status) => {
      setIsConnected(status === 'SUBSCRIBED');
    });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, enabled, messagesFilter, conversationsFilter]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
