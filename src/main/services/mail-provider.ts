/**
 * Abstract MailProvider interface.
 *
 * This interface defines the contract that any mail provider (Gmail, Outlook, etc.)
 * must implement. It abstracts away provider-specific concepts:
 *   - Gmail labels → canonical folder/flag representation
 *   - Gmail History API / Outlook delta queries → generic SyncChanges
 *   - Gmail draft IDs → provider-opaque draft IDs
 *
 * Design decisions:
 *   - We keep `labelIds: string[]` on emails for backward compatibility. Providers
 *     map their native concepts to canonical label strings: "INBOX", "SENT", "UNREAD",
 *     "STARRED", "TRASH", "DRAFT". This avoids a massive refactor of the renderer
 *     and DB layer which both use these strings extensively.
 *   - The `SyncChanges` type uses an opaque `cursor` string. Gmail stores a historyId,
 *     Outlook stores a deltaLink. The sync service doesn't need to know the format.
 */

import type {
  Email,
  EmailSearchResult,
  SentEmail,
  GmailDraft,
  SendMessageOptions,
  ComposeMessageOptions,
} from "../../shared/types";

// ────────────────────────────────────────────
// Provider type enum
// ────────────────────────────────────────────

export type MailProviderType = "gmail" | "outlook";

// ────────────────────────────────────────────
// Sync types
// ────────────────────────────────────────────

/**
 * Incremental sync result from any provider.
 * The `cursor` is opaque — Gmail uses a historyId, Outlook uses a deltaLink.
 */
export interface SyncChanges {
  newMessageIds: string[];
  deletedMessageIds: string[];
  readMessageIds: string[];
  unreadMessageIds: string[];
  /** Opaque cursor for the next incremental sync call */
  cursor: string;
}

// ────────────────────────────────────────────
// MailProvider interface
// ────────────────────────────────────────────

export interface MailProvider {
  // ── Identity ──
  readonly accountId: string;
  readonly providerType: MailProviderType;

  // ── Lifecycle ──
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reauth(): Promise<void>;
  abortOAuth(): void;

  // ── Credential / token checks ──
  hasCredentials(): boolean;
  hasTokens(): boolean;
  checkTokenHealth(): Promise<boolean>;
  removeTokens(): Promise<void>;

  // ── Account info ──
  getProfile(): Promise<{ emailAddress: string; messagesTotal: number; historyId: string }>;
  fetchDisplayName(): Promise<string | null>;
  clearAccountInfoCache(): void;

  // ── Reading ──
  readEmail(messageId: string): Promise<Email | null>;
  getMessages(messageIds: string[], concurrency?: number): Promise<Email[]>;
  getThread(threadId: string): Promise<Email[]>;
  getAttachment(messageId: string, attachmentId: string): Promise<string>;
  getMessageHeaders(
    messageId: string,
  ): Promise<{ messageId: string; references: string; subject: string } | null>;

  // ── Searching ──
  searchEmails(
    query: string,
    maxResults?: number,
    pageToken?: string,
  ): Promise<{ results: EmailSearchResult[]; nextPageToken?: string }>;
  searchAllEmails(query: string, maxTotal?: number): Promise<EmailSearchResult[]>;
  getEmailsByLabel(labelId: string, maxResults?: number): Promise<EmailSearchResult[]>;
  getLabelCount(labelId: string): Promise<number>;
  findMessageByRfc822Id(rfc822MessageId: string): Promise<string | null>;
  searchSentEmails(maxResults?: number): Promise<SentEmail[]>;

  // ── Sync ──
  getLastHistoryId(): string | null;
  setLastHistoryId(historyId: string | null): void;
  getHistoryChanges(startHistoryId: string): Promise<SyncChanges>;

  // ── Mutations ──
  archiveMessage(messageId: string): Promise<void>;
  batchArchive(messageIds: string[]): Promise<void>;
  restoreToInbox(messageId: string): Promise<void>;
  trashMessage(messageId: string): Promise<void>;
  batchTrash(messageIds: string[]): Promise<{ failedIds: string[] }>;
  setStarred(messageId: string, starred: boolean): Promise<void>;
  setRead(messageId: string, read: boolean): Promise<void>;
  markThreadAsRead(threadId: string): Promise<void>;

  // ── Sending & Drafts ──
  sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId: string }>;
  createDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string;
  }): Promise<{ id: string }>;
  createFullDraft(options: ComposeMessageOptions): Promise<{ id: string; messageId: string }>;
  updateDraft(
    draftId: string,
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }>;
  sendDraft(draftId: string): Promise<{ id: string; threadId: string }>;
  listDrafts(maxResults?: number): Promise<GmailDraft[]>;
  getDraft(draftId: string): Promise<GmailDraft | null>;
  deleteDraft(draftId: string): Promise<void>;

  // ── Capabilities ──
  listCapabilities(): Promise<string[]>;

  // ── OAuth credentials (provider-specific but needed by IPC layer) ──
  saveCredentials(clientId: string, clientSecret: string): Promise<void>;
}

/**
 * Type guard: check if an error is an authentication error for any provider.
 * Each provider module should export its own `isAuthError` function;
 * this is a convenience re-export pattern.
 */
export function isProviderAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();

  // Gmail patterns
  if (msg.includes("invalid_grant") || msg.includes("token has been expired or revoked")) {
    return true;
  }

  // Outlook patterns
  if (
    msg.includes("invalid_token") ||
    msg.includes("interaction_required") ||
    msg.includes("expired_token")
  ) {
    return true;
  }

  // HTTP 401 from any provider
  const anyErr = error as unknown as Record<string, unknown>;
  if (anyErr.code === 401 || anyErr.status === 401) {
    return true;
  }

  return false;
}
