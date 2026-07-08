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

export interface Message {
  id: string;
  conversation_id: string;
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
}
