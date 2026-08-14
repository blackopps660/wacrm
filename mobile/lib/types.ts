// Ported subset of src/types/index.ts (web app) — only the shapes
// this app needs so far (Inbox in Phase 1, Contacts in Phase 3).

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface LifecycleStage {
  id: string;
  account_id: string;
  name: string;
  color: string;
  position: number;
  is_lost: boolean;
  created_at: string;
}

export interface ContactNote {
  id: string;
  contact_id: string;
  account_id: string;
  user_id: string;
  note_text: string;
  created_at: string;
}

export interface Contact {
  id: string;
  user_id: string;
  account_id: string;
  phone: string;
  phone_normalized?: string;
  name?: string;
  email?: string;
  company?: string;
  avatar_url?: string;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  lifecycle_stage_id?: string | null;
  lifecycle_stage?: LifecycleStage | null;
  blocked_at?: string | null;
}

export type ConversationStatus = 'open' | 'pending' | 'closed';
export type ConversationOwnerKind = 'unassigned' | 'human' | 'ai';

export interface Conversation {
  id: string;
  user_id: string;
  contact_id: string;
  status: ConversationStatus;
  assigned_agent_id?: string;
  owner_kind: ConversationOwnerKind;
  last_message_text?: string;
  last_message_at?: string;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact?: Contact;
  pinned_at?: string | null;
  muted_at?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

export type SenderType = 'customer' | 'agent' | 'bot';
export type ContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  | 'interactive';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export type MessageTemplateStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAUSED'
  | 'DISABLED'
  | 'IN_APPEAL'
  | 'PENDING_DELETION';

export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; text: string; example: string };

export interface MessageTemplate {
  id: string;
  account_id: string;
  name: string;
  category: 'Marketing' | 'Utility' | 'Authentication';
  language?: string;
  header_type?: 'text' | 'image' | 'video' | 'document';
  header_content?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  status?: MessageTemplateStatus;
}

export interface Message {
  id: string;
  conversation_id: string;
  /** Denormalized from conversations.account_id (migration 052) so
   *  Realtime can filter this table server-side. */
  account_id?: string;
  sender_type: SenderType;
  sender_id?: string;
  content_type: ContentType;
  content_text?: string;
  media_url?: string;
  template_name?: string;
  message_id?: string;
  status: MessageStatus;
  created_at: string;
  reply_to_message_id?: string;
  interactive_reply_id?: string;
  error_message?: string | null;
  deleted_at?: string | null;
  /** When this message was pinned to the top of its conversation (migration 057). */
  pinned_at?: string | null;
  /** When the pin auto-expires — counts as pinned only while `pinned_until > now()`. */
  pinned_until?: string | null;
}
