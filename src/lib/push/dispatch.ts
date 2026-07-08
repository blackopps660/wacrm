// ============================================================
// Expo push dispatch — the mobile app's "app backgrounded/killed"
// notification path (Phase 6). Realtime (Supabase channels) already
// covers "app open"; this covers the rest.
//
// Mirrors dispatchWebhookEvent's calling contract (src/lib/webhooks/
// deliver.ts): takes the already-instantiated service-role client,
// never throws, safe to `await` inside the webhook route's `after()`
// block. Called once per inbound message, right alongside the
// existing `message.received` webhook dispatch.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { Expo, type ExpoPushMessage } from 'expo-server-sdk'

let _expo: Expo | null = null
function expoClient(): Expo {
  if (!_expo) _expo = new Expo()
  return _expo
}

export interface DispatchPushForNewMessageArgs {
  accountId: string
  /** Contact's display name (falls back to phone at the call site). */
  senderName: string
  /** Message preview — caption/body text, or a `[image]`-style placeholder. */
  previewText: string
  conversationId: string
}

const PREVIEW_MAX_LENGTH = 120

export async function dispatchPushForNewMessage(
  db: SupabaseClient,
  args: DispatchPushForNewMessageArgs,
): Promise<void> {
  try {
    const { accountId, senderName, previewText, conversationId } = args

    const { data: tokenRows, error } = await db
      .from('push_device_tokens')
      .select('expo_push_token')
      .eq('account_id', accountId)

    if (error) {
      console.error('[push] failed to load device tokens:', error.message)
      return
    }
    if (!tokenRows || tokenRows.length === 0) return

    // WhatsApp-style grouping: one notification per conversation, not
    // one per message. `conversations.unread_count` is already the
    // running tally of unseen messages for this thread (bumped by the
    // webhook handler before this runs) — reuse it as the "N messages"
    // count instead of tracking a separate counter. `tag` (Android) /
    // `collapseId` (the cross-platform field Expo maps to iOS's
    // apns-collapse-id) makes a new push REPLACE the previous one for
    // the same conversation in the tray rather than stacking beside it.
    const { data: convRow } = await db
      .from('conversations')
      .select('unread_count')
      .eq('id', conversationId)
      .maybeSingle()
    const unreadCount = (convRow as { unread_count: number } | null)?.unread_count ?? 1

    const truncatedPreview =
      previewText.length > PREVIEW_MAX_LENGTH
        ? `${previewText.slice(0, PREVIEW_MAX_LENGTH)}…`
        : previewText
    const body =
      unreadCount > 1 ? `${unreadCount} new messages · ${truncatedPreview}` : truncatedPreview

    const expo = expoClient()
    const messages: ExpoPushMessage[] = []

    for (const row of tokenRows as { expo_push_token: string }[]) {
      const token = row.expo_push_token
      if (!Expo.isExpoPushToken(token)) {
        console.warn('[push] skipping malformed Expo push token:', token)
        continue
      }
      messages.push({
        to: token,
        sound: 'default',
        title: senderName,
        body,
        data: { conversationId },
        tag: conversationId,
        collapseId: conversationId,
      })
    }

    if (messages.length === 0) return

    const chunks = expo.chunkPushNotifications(messages)
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk)
        for (const ticket of tickets) {
          if (ticket.status === 'error') {
            console.warn('[push] delivery ticket error:', ticket.message, ticket.details)
          }
        }
      } catch (err) {
        console.error('[push] sendPushNotificationsAsync failed:', err)
      }
    }
  } catch (err) {
    // Never let a push-delivery failure affect inbound message
    // processing — same defensive contract as dispatchWebhookEvent.
    console.error('[push] dispatchPushForNewMessage threw:', err)
  }
}
