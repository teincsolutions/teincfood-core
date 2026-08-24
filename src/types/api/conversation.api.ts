import type { PaginationMeta } from './pagination';

export interface ConversationParticipant {
  id: string;
  user_id: string;
  archived_at: string | null;
}

export interface Conversation {
  id: string;
  type: string;
  status: string;
  assigned_agent_id: string | null;
  order_id: string | null;
  participants: ConversationParticipant[];
  inserted_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  content: string;
  sender_id: string;
  conversation_id: string;
  direction: string;
  channel: string;
  message_type: string;
  status: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  replied_by_id: string | null;
  read: boolean;
  inserted_at: string;
}

export interface ConversationListResponse {
  data: Conversation[];
  pagination: PaginationMeta;
}

export interface ConversationResponse {
  data: Conversation;
}

export interface ConversationMessagesResponse {
  data: ConversationMessage[];
  meta: {
    limit: number;
    offset: number;
    count: number;
  };
}
