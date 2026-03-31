/**
 * Outlook/Microsoft Graph mail provider.
 *
 * Uses Microsoft Graph REST API v1.0 for all mail operations.
 * OAuth2 with PKCE via MSAL (Microsoft Authentication Library).
 *
 * Key mapping decisions:
 *   - Outlook folders → canonical label strings ("INBOX", "SENT", "TRASH", "DRAFT")
 *   - Outlook `isRead` boolean → "UNREAD" label (when isRead === false)
 *   - Outlook `flag.flagStatus === "flagged"` → "STARRED" label
 *   - Outlook `conversationId` → threadId
 *   - Outlook delta queries → opaque sync cursor
 */

import { createServer, type Server } from "http";
import { readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { shell } from "electron";
import { randomBytes, createHash } from "crypto";
import type {
  Email,
  EmailSearchResult,
  SentEmail,
  GmailDraft,
  SendMessageOptions,
  ComposeMessageOptions,
  AttachmentMeta,
} from "../../shared/types";
import type { MailProvider, SyncChanges } from "./mail-provider";
import { getDataDir } from "../data-dir";
import { createLogger } from "./logger";

const log = createLogger("outlook");

// ────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const REDIRECT_URI = "http://localhost:3848/oauth2callback";
const REDIRECT_PORT = 3848;

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
  "User.Read",
  "Calendars.Read",
];

// Well-known Outlook folder IDs
const FOLDER_INBOX = "inbox";
const FOLDER_SENT = "sentitems";
const FOLDER_DRAFTS = "drafts";
const FOLDER_DELETED = "deleteditems";

// ────────────────────────────────────────────
// Token / credential paths
// ────────────────────────────────────────────

function getConfigDir(): string {
  return getDataDir();
}

function getOutlookCredentialsFile(): string {
  return join(getConfigDir(), "outlook-credentials.json");
}

function getOutlookTokensFile(accountId: string): string {
  if (accountId === "default") {
    return join(getConfigDir(), "outlook-tokens.json");
  }
  return join(getConfigDir(), `outlook-tokens-${accountId}.json`);
}

interface OutlookCredentials {
  client_id: string;
  // Outlook public client apps (native/desktop) don't need a client_secret.
  // PKCE is used instead.
  client_secret?: string;
}

interface OutlookTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  id_token?: string;
}

// Bundled Outlook credentials (set via env vars at build time)
const _outlookClientId = import.meta.env.MAIN_VITE_OUTLOOK_CLIENT_ID ?? "";
const BUNDLED_OUTLOOK_CREDENTIALS: OutlookCredentials | null = _outlookClientId
  ? { client_id: _outlookClientId }
  : null;

// ────────────────────────────────────────────
// Microsoft Graph response types
// ────────────────────────────────────────────

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  bccRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  sentDateTime: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  isRead: boolean;
  isDraft: boolean;
  flag?: { flagStatus: string };
  hasAttachments: boolean;
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  parentFolderId?: string;
  attachments?: GraphAttachment[];
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
}

interface GraphDeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// ────────────────────────────────────────────
// Helper: detect auth errors
// ────────────────────────────────────────────

export function isOutlookAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (
    msg.includes("invalid_token") ||
    msg.includes("interaction_required") ||
    msg.includes("expired_token") ||
    msg.includes("invalidauthenticationtoken")
  ) {
    return true;
  }
  const anyErr = error as unknown as Record<string, unknown>;
  if (anyErr.code === 401 || anyErr.status === 401) {
    return true;
  }
  return false;
}

// ────────────────────────────────────────────
// OutlookClient
// ────────────────────────────────────────────

export class OutlookClient implements MailProvider {
  readonly providerType = "outlook" as const;
  readonly accountId: string;

  private credentials: OutlookCredentials | null = null;
  private tokens: OutlookTokens | null = null;
  private lastSyncCursor: string | null = null;
  private cachedAccountInfo: { email: string; displayName: string | null } | null | undefined =
    undefined;
  private pendingOAuthServer: Server | null = null;
  private pendingOAuthReject: ((reason: Error) => void) | null = null;
  private pendingOAuthTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(accountId: string = "default") {
    this.accountId = accountId;
  }

  getAccountId(): string {
    return this.accountId;
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    this.credentials = await this.loadCredentials();
    this.tokens = await this.loadOrRefreshTokens();
    log.info(`Connected to Microsoft Graph API for account ${this.accountId}`);
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
    this.credentials = null;
    log.info(`Disconnected from Microsoft Graph API for account ${this.accountId}`);
  }

  async reauth(): Promise<void> {
    if (!this.credentials) {
      this.credentials = await this.loadCredentials();
    }
    this.tokens = await this.doOAuthFlow();
    log.info(`[Outlook] Re-authenticated account ${this.accountId}`);
  }

  abortOAuth(): void {
    if (this.pendingOAuthServer) {
      this.pendingOAuthServer.closeAllConnections();
      this.pendingOAuthServer.close();
      this.pendingOAuthServer = null;
    }
    if (this.pendingOAuthReject) {
      this.pendingOAuthReject(new Error("Authorization cancelled"));
      this.pendingOAuthReject = null;
    }
  }

  // ── Credential / token checks ──

  hasCredentials(): boolean {
    return BUNDLED_OUTLOOK_CREDENTIALS !== null || existsSync(getOutlookCredentialsFile());
  }

  hasTokens(): boolean {
    return existsSync(getOutlookTokensFile(this.accountId));
  }

  async checkTokenHealth(): Promise<boolean> {
    try {
      await this.getProfile();
      return true;
    } catch (err) {
      if (isOutlookAuthError(err)) return false;
      throw err;
    }
  }

  async removeTokens(): Promise<void> {
    const tokensFile = getOutlookTokensFile(this.accountId);
    try {
      await unlink(tokensFile);
      log.info(`[Outlook] Deleted token file for account ${this.accountId}`);
    } catch {
      // File may not exist
    }
  }

  async saveCredentials(clientId: string, _clientSecret: string): Promise<void> {
    if (!clientId) {
      throw new Error("Client ID is required for Outlook");
    }
    await writeFile(
      getOutlookCredentialsFile(),
      JSON.stringify({ client_id: clientId.trim() }, null, 2),
    );
  }

  // ── Account info ──

  async getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    historyId: string;
  }> {
    const data = await this.graphGet<{
      mail: string;
      userPrincipalName: string;
      displayName: string;
    }>("/me");
    const email = data.mail || data.userPrincipalName;

    // Outlook doesn't have an equivalent of Gmail's historyId on the profile.
    // We return an empty string; actual sync cursors are obtained from delta queries.
    return {
      emailAddress: email,
      messagesTotal: 0,
      historyId: "",
    };
  }

  async fetchDisplayName(): Promise<string | null> {
    try {
      const data = await this.graphGet<{ displayName: string }>("/me");
      return data.displayName?.trim() || null;
    } catch (err) {
      log.warn({ err }, "[Outlook] Failed to fetch display name");
      return null;
    }
  }

  clearAccountInfoCache(): void {
    this.cachedAccountInfo = undefined;
  }

  // ── Reading ──

  async readEmail(messageId: string): Promise<Email | null> {
    try {
      const msg = await this.graphGet<GraphMessage>(
        `/me/messages/${messageId}?$expand=attachments`,
      );
      return this.graphMessageToEmail(msg);
    } catch (err) {
      log.error({ err }, `[Outlook] Failed to read email ${messageId}`);
      return null;
    }
  }

  async getMessages(messageIds: string[], concurrency: number = 10): Promise<Email[]> {
    const results: Email[] = [];
    for (let i = 0; i < messageIds.length; i += concurrency) {
      const chunk = messageIds.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((id) => this.readEmail(id)));
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
          results.push(result.value);
        }
      }
    }
    return results;
  }

  async getThread(threadId: string): Promise<Email[]> {
    // Outlook groups by conversationId
    const resp = await this.graphGet<{ value: GraphMessage[] }>(
      `/me/messages?$filter=conversationId eq '${threadId}'&$expand=attachments&$orderby=receivedDateTime asc&$top=100`,
    );
    const emails: Email[] = [];
    for (const msg of resp.value) {
      // Filter out drafts (same as Gmail's DRAFT filter)
      if (msg.isDraft) continue;
      emails.push(this.graphMessageToEmail(msg));
    }
    return emails;
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<string> {
    const data = await this.graphGet<{ contentBytes: string }>(
      `/me/messages/${messageId}/attachments/${attachmentId}`,
    );
    return data.contentBytes || "";
  }

  async getMessageHeaders(
    messageId: string,
  ): Promise<{ messageId: string; references: string; subject: string } | null> {
    try {
      const msg = await this.graphGet<GraphMessage>(
        `/me/messages/${messageId}?$select=internetMessageHeaders,subject`,
      );
      const headers = msg.internetMessageHeaders || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
      return {
        messageId: getHeader("message-id"),
        references: getHeader("references"),
        subject: msg.subject || "",
      };
    } catch (err) {
      log.error({ err }, `[Outlook] Failed to get headers for ${messageId}`);
      return null;
    }
  }

  // ── Searching ──

  async searchEmails(
    query: string,
    maxResults: number = 50,
    pageToken?: string,
  ): Promise<{ results: EmailSearchResult[]; nextPageToken?: string }> {
    const url = pageToken
      ? pageToken // nextLink from previous call
      : `/me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,conversationId,bodyPreview`;
    const data = await this.graphGet<{
      value: Array<{ id: string; conversationId: string; bodyPreview: string }>;
      "@odata.nextLink"?: string;
    }>(url);
    return {
      results: data.value.map((m) => ({
        id: m.id,
        threadId: m.conversationId,
        snippet: m.bodyPreview || "",
      })),
      nextPageToken: data["@odata.nextLink"],
    };
  }

  async searchAllEmails(query: string, maxTotal: number = 0): Promise<EmailSearchResult[]> {
    const all: EmailSearchResult[] = [];
    let pageToken: string | undefined;
    do {
      const result = await this.searchEmails(query, 50, pageToken);
      all.push(...result.results);
      pageToken = result.nextPageToken;
      if (maxTotal > 0 && all.length >= maxTotal) {
        return all.slice(0, maxTotal);
      }
    } while (pageToken);
    return all;
  }

  async getEmailsByLabel(labelId: string, maxResults: number = 500): Promise<EmailSearchResult[]> {
    // Map canonical label to Outlook folder
    const folderId = this.canonicalLabelToFolder(labelId);
    const all: EmailSearchResult[] = [];
    let url: string | undefined =
      `/me/mailFolders/${folderId}/messages?$top=${Math.min(maxResults, 100)}&$select=id,conversationId,bodyPreview&$orderby=receivedDateTime desc`;

    do {
      const data = await this.graphGet<{
        value: Array<{ id: string; conversationId: string; bodyPreview: string }>;
        "@odata.nextLink"?: string;
      }>(url!);
      for (const m of data.value) {
        all.push({ id: m.id, threadId: m.conversationId, snippet: m.bodyPreview || "" });
      }
      url = data["@odata.nextLink"];
      if (all.length >= maxResults) return all.slice(0, maxResults);
    } while (url);

    return all;
  }

  async getLabelCount(labelId: string): Promise<number> {
    const folderId = this.canonicalLabelToFolder(labelId);
    const data = await this.graphGet<{ totalItemCount: number }>(
      `/me/mailFolders/${folderId}?$select=totalItemCount`,
    );
    return data.totalItemCount || 0;
  }

  async findMessageByRfc822Id(rfc822MessageId: string): Promise<string | null> {
    // Outlook can filter by internetMessageId
    const cleanId = rfc822MessageId.replace(/[<>]/g, "");
    const data = await this.graphGet<{ value: Array<{ id: string }> }>(
      `/me/messages?$filter=internetMessageId eq '<${cleanId}>'&$select=id&$top=1`,
    );
    return data.value.length > 0 ? data.value[0].id : null;
  }

  async searchSentEmails(maxResults: number = 500): Promise<SentEmail[]> {
    const results = await this.getEmailsByLabel("SENT", maxResults);
    const sentEmails: SentEmail[] = [];
    for (const r of results) {
      try {
        const email = await this.readEmail(r.id);
        if (email) {
          sentEmails.push({
            id: email.id,
            toAddress: email.to,
            subject: email.subject,
            body: email.body,
            date: email.date,
          });
        }
      } catch (err) {
        log.error({ err }, `[Outlook] Failed to read sent email ${r.id}`);
      }
    }
    return sentEmails;
  }

  // ── Sync ──

  getLastHistoryId(): string | null {
    return this.lastSyncCursor;
  }

  setLastHistoryId(cursor: string | null): void {
    this.lastSyncCursor = cursor;
  }

  async getHistoryChanges(startCursor: string): Promise<SyncChanges> {
    // Use the delta query with the stored deltaLink to get incremental changes
    const newMessageIds: string[] = [];
    const deletedMessageIds: string[] = [];
    const readMessageIds: string[] = [];
    const unreadMessageIds: string[] = [];

    let url = startCursor; // deltaLink from previous sync
    let latestCursor = startCursor;

    try {
      do {
        const data = await this.graphGet<GraphDeltaResponse>(url);

        for (const msg of data.value) {
          // The @removed property indicates a deletion
          const removed = (msg as Record<string, unknown>)["@removed"];
          if (removed) {
            deletedMessageIds.push(msg.id);
            continue;
          }

          // Check if this is a new message or an update
          // Delta responses don't distinguish — we check against known IDs externally.
          // For now, treat all non-removed messages as potentially new.
          newMessageIds.push(msg.id);

          // Track read/unread changes
          if (msg.isRead !== undefined) {
            if (msg.isRead) {
              readMessageIds.push(msg.id);
            } else {
              unreadMessageIds.push(msg.id);
            }
          }
        }

        if (data["@odata.deltaLink"]) {
          latestCursor = data["@odata.deltaLink"];
        }
        url = data["@odata.nextLink"] || "";
      } while (url);

      this.lastSyncCursor = latestCursor;

      return {
        newMessageIds: [...new Set(newMessageIds)],
        deletedMessageIds: [...new Set(deletedMessageIds)],
        readMessageIds: [...new Set(readMessageIds)],
        unreadMessageIds: [...new Set(unreadMessageIds)],
        cursor: latestCursor,
      };
    } catch (error: unknown) {
      const errObj = error as { code?: number; status?: number; message?: string };
      // Delta token expired — caller should do full sync
      if (errObj.status === 410 || errObj.message?.includes("syncStateNotFound")) {
        throw new Error("HISTORY_EXPIRED");
      }
      throw error;
    }
  }

  /**
   * Initialize a delta query for the inbox folder.
   * Returns the initial deltaLink to be stored as the sync cursor.
   * Must be called during first-time full sync.
   */
  async initDeltaSync(): Promise<string> {
    let url: string | undefined =
      `/me/mailFolders/inbox/messages/delta?$select=id,conversationId,isRead,isDraft,flag`;
    let deltaLink = "";

    do {
      const data = await this.graphGet<GraphDeltaResponse>(url!);
      if (data["@odata.deltaLink"]) {
        deltaLink = data["@odata.deltaLink"];
      }
      url = data["@odata.nextLink"];
    } while (url);

    return deltaLink;
  }

  // ── Mutations ──

  async archiveMessage(messageId: string): Promise<void> {
    // Outlook: move to Archive folder (or just remove from inbox by moving to a generic folder)
    // The "archive" folder ID is "archive" in Graph API
    await this.graphPost(`/me/messages/${messageId}/move`, { destinationId: "archive" });
  }

  async batchArchive(messageIds: string[]): Promise<void> {
    // Outlook doesn't have a batch move — use concurrent individual moves
    const CONCURRENCY = 5;
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
      const batch = messageIds.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map((id) => this.archiveMessage(id)));
    }
  }

  async restoreToInbox(messageId: string): Promise<void> {
    await this.graphPost(`/me/messages/${messageId}/move`, { destinationId: "inbox" });
  }

  async trashMessage(messageId: string): Promise<void> {
    // Move to deleted items folder
    await this.graphPost(`/me/messages/${messageId}/move`, {
      destinationId: FOLDER_DELETED,
    });
  }

  async batchTrash(messageIds: string[]): Promise<{ failedIds: string[] }> {
    if (messageIds.length === 0) return { failedIds: [] };
    const failedIds: string[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
      const batch = messageIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((id) => this.trashMessage(id)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") failedIds.push(batch[j]);
      }
    }
    return { failedIds };
  }

  async setStarred(messageId: string, starred: boolean): Promise<void> {
    await this.graphPatch(`/me/messages/${messageId}`, {
      flag: { flagStatus: starred ? "flagged" : "notFlagged" },
    });
  }

  async setRead(messageId: string, read: boolean): Promise<void> {
    await this.graphPatch(`/me/messages/${messageId}`, { isRead: read });
  }

  async markThreadAsRead(threadId: string): Promise<void> {
    // Get all unread messages in this conversation and mark each as read
    const data = await this.graphGet<{ value: Array<{ id: string }> }>(
      `/me/messages?$filter=conversationId eq '${threadId}' and isRead eq false&$select=id`,
    );
    const CONCURRENCY = 5;
    for (let i = 0; i < data.value.length; i += CONCURRENCY) {
      const batch = data.value.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map((m) => this.setRead(m.id, true)));
    }
  }

  // ── Sending & Drafts ──

  async sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId: string }> {
    const message = this.buildGraphMessage(options);
    const data = await this.graphPost<{ id: string; conversationId: string }>("/me/sendMail", {
      message,
      saveToSentItems: true,
    });
    // sendMail returns 202 with no body. We return placeholder IDs.
    return { id: data?.id || "", threadId: data?.conversationId || options.threadId || "" };
  }

  async createDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string;
  }): Promise<{ id: string }> {
    const message: Record<string, unknown> = {
      subject: params.subject,
      body: { contentType: "html", content: params.body },
      toRecipients: [{ emailAddress: { address: params.to } }],
    };
    if (params.cc?.length) {
      message.ccRecipients = params.cc.map((addr) => ({ emailAddress: { address: addr } }));
    }
    if (params.bcc?.length) {
      message.bccRecipients = params.bcc.map((addr) => ({ emailAddress: { address: addr } }));
    }

    const data = await this.graphPost<{ id: string }>("/me/messages", message);
    return { id: data.id };
  }

  async createFullDraft(
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    const message = this.buildGraphMessage(options);
    const data = await this.graphPost<{ id: string }>("/me/messages", message);
    return { id: data.id, messageId: data.id };
  }

  async updateDraft(
    draftId: string,
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    const message = this.buildGraphMessage(options);
    await this.graphPatch(`/me/messages/${draftId}`, message);
    return { id: draftId, messageId: draftId };
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    await this.graphPost(`/me/messages/${draftId}/send`, {});
    return { id: draftId, threadId: "" };
  }

  async listDrafts(maxResults: number = 100): Promise<GmailDraft[]> {
    const data = await this.graphGet<{ value: GraphMessage[] }>(
      `/me/mailFolders/${FOLDER_DRAFTS}/messages?$top=${maxResults}&$expand=attachments`,
    );
    return data.value.map((msg) => this.graphMessageToDraft(msg));
  }

  async getDraft(draftId: string): Promise<GmailDraft | null> {
    try {
      const msg = await this.graphGet<GraphMessage>(`/me/messages/${draftId}?$expand=attachments`);
      return this.graphMessageToDraft(msg);
    } catch {
      return null;
    }
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.graphDelete(`/me/messages/${draftId}`);
  }

  // ── Capabilities ──

  async listCapabilities(): Promise<string[]> {
    return ["search_emails", "read_email", "create_draft"];
  }

  // ══════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════

  // ── Credential / token management ──

  private async loadCredentials(): Promise<OutlookCredentials> {
    const credFile = getOutlookCredentialsFile();
    if (existsSync(credFile)) {
      const content = await readFile(credFile, "utf-8");
      return JSON.parse(content);
    }
    if (BUNDLED_OUTLOOK_CREDENTIALS) {
      return BUNDLED_OUTLOOK_CREDENTIALS;
    }
    throw new Error(
      `CREDENTIALS_REQUIRED: No Outlook credentials available. ` +
        `Place outlook-credentials.json in ${getConfigDir()}/ or build with MAIN_VITE_OUTLOOK_CLIENT_ID env var.`,
    );
  }

  private async loadOrRefreshTokens(): Promise<OutlookTokens> {
    const tokensFile = getOutlookTokensFile(this.accountId);
    if (existsSync(tokensFile)) {
      const content = await readFile(tokensFile, "utf-8");
      const tokens: OutlookTokens = JSON.parse(content);

      // Refresh if expired (5 minute buffer)
      if (tokens.expires_at < Date.now() + 5 * 60 * 1000 && tokens.refresh_token) {
        log.info(`[Outlook] Token expired for ${this.accountId}, refreshing`);
        try {
          return await this.refreshTokens(tokens.refresh_token);
        } catch (err) {
          log.error({ err }, `[Outlook] Token refresh failed for ${this.accountId}`);
          throw err;
        }
      }
      return tokens;
    }
    return this.doOAuthFlow();
  }

  private async refreshTokens(refreshToken: string): Promise<OutlookTokens> {
    const params = new URLSearchParams({
      client_id: this.credentials!.client_id,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPES.join(" "),
    });

    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Token refresh failed: ${resp.status} ${errBody}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      id_token?: string;
    };

    const tokens: OutlookTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
      id_token: data.id_token,
    };

    await writeFile(getOutlookTokensFile(this.accountId), JSON.stringify(tokens, null, 2));
    this.tokens = tokens;
    return tokens;
  }

  private async doOAuthFlow(): Promise<OutlookTokens> {
    // PKCE: generate code_verifier and code_challenge
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const authUrl = new URL(`${AUTH_BASE}/authorize`);
    authUrl.searchParams.set("client_id", this.credentials!.client_id);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("scope", SCOPES.join(" "));
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("prompt", "consent");

    log.info("[Outlook] Opening browser for Microsoft authorization...");
    await shell.openExternal(authUrl.toString());

    const code = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        if (this.pendingOAuthTimeout) {
          clearTimeout(this.pendingOAuthTimeout);
          this.pendingOAuthTimeout = null;
        }
        this.pendingOAuthServer = null;
        this.pendingOAuthReject = null;
      };

      const server = createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
        const authCode = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (authCode) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                  <h1>Exo Connected (Outlook)</h1>
                  <p>You can close this tab and return to the application.</p>
                </div>
              </body>
            </html>
          `);
          server.closeAllConnections();
          server.close();
          cleanup();
          resolve(authCode);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end(`Authorization failed: ${error || "unknown error"}`);
          server.closeAllConnections();
          server.close();
          cleanup();
          reject(new Error(error || "Missing authorization code"));
        }
      });

      this.pendingOAuthServer = server;
      this.pendingOAuthReject = (reason: Error) => {
        cleanup();
        reject(reason);
      };

      server.listen(REDIRECT_PORT, () => {
        log.info("[Outlook] Waiting for authorization...");
      });

      this.pendingOAuthTimeout = setTimeout(
        () => {
          server.closeAllConnections();
          server.close();
          cleanup();
          reject(new Error("Authorization timeout"));
        },
        5 * 60 * 1000,
      );
    });

    // Exchange code for tokens
    const params = new URLSearchParams({
      client_id: this.credentials!.client_id,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${errBody}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      id_token?: string;
    };

    const tokens: OutlookTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      id_token: data.id_token,
    };

    await writeFile(getOutlookTokensFile(this.accountId), JSON.stringify(tokens, null, 2));
    this.tokens = tokens;
    log.info(`[Outlook] Authorization successful for account ${this.accountId}`);
    return tokens;
  }

  // ── Graph API helpers ──

  private async ensureValidToken(): Promise<string> {
    if (!this.tokens) throw new Error("Not connected");
    // Auto-refresh if expired
    if (this.tokens.expires_at < Date.now() + 60_000) {
      this.tokens = await this.refreshTokens(this.tokens.refresh_token);
    }
    return this.tokens.access_token;
  }

  private async graphGet<T>(urlOrPath: string): Promise<T> {
    const token = await this.ensureValidToken();
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      const err = new Error(`Graph GET ${urlOrPath} failed: ${resp.status} ${body}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
    return resp.json() as Promise<T>;
  }

  private async graphPost<T = unknown>(urlOrPath: string, body: unknown): Promise<T> {
    const token = await this.ensureValidToken();
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text();
      const err = new Error(`Graph POST ${urlOrPath} failed: ${resp.status} ${respBody}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
    // Some endpoints return 202/204 with no body
    const text = await resp.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async graphPatch(urlOrPath: string, body: unknown): Promise<void> {
    const token = await this.ensureValidToken();
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text();
      const err = new Error(`Graph PATCH ${urlOrPath} failed: ${resp.status} ${respBody}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
  }

  private async graphDelete(urlOrPath: string): Promise<void> {
    const token = await this.ensureValidToken();
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH_BASE}${urlOrPath}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const respBody = await resp.text();
      const err = new Error(`Graph DELETE ${urlOrPath} failed: ${resp.status} ${respBody}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
  }

  // ── Data mapping ──

  /**
   * Map canonical labels ("INBOX", "SENT", etc.) to Outlook well-known folder IDs.
   */
  private canonicalLabelToFolder(label: string): string {
    switch (label) {
      case "INBOX":
        return FOLDER_INBOX;
      case "SENT":
        return FOLDER_SENT;
      case "TRASH":
        return FOLDER_DELETED;
      case "DRAFT":
        return FOLDER_DRAFTS;
      default:
        return label.toLowerCase();
    }
  }

  /**
   * Build canonical labelIds from an Outlook message.
   *
   * We map Outlook's folder + boolean fields to the same label strings
   * that Gmail uses, so the rest of the codebase works unchanged.
   */
  private buildCanonicalLabels(msg: GraphMessage): string[] {
    const labels: string[] = [];

    // Folder-based labels
    const folderId = (msg.parentFolderId || "").toLowerCase();
    if (folderId.includes("inbox") || folderId === FOLDER_INBOX) {
      labels.push("INBOX");
    }
    if (folderId.includes("sent") || folderId === FOLDER_SENT) {
      labels.push("SENT");
    }
    if (folderId.includes("deleted") || folderId === FOLDER_DELETED) {
      labels.push("TRASH");
    }
    if (folderId.includes("draft") || folderId === FOLDER_DRAFTS) {
      labels.push("DRAFT");
    }

    // Boolean flags → labels
    if (!msg.isRead) {
      labels.push("UNREAD");
    }
    if (msg.flag?.flagStatus === "flagged") {
      labels.push("STARRED");
    }

    return labels;
  }

  /**
   * Format address list from Graph recipients: "Name <email>" or just "email"
   */
  private formatRecipients(
    recipients?: Array<{ emailAddress: { name: string; address: string } }>,
  ): string {
    if (!recipients?.length) return "";
    return recipients
      .map((r) =>
        r.emailAddress.name
          ? `${r.emailAddress.name} <${r.emailAddress.address}>`
          : r.emailAddress.address,
      )
      .join(", ");
  }

  /**
   * Convert a Microsoft Graph message to our canonical Email type.
   */
  private graphMessageToEmail(msg: GraphMessage): Email {
    const from = msg.from
      ? msg.from.emailAddress.name
        ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
        : msg.from.emailAddress.address
      : "";

    const to = this.formatRecipients(msg.toRecipients);
    const cc = this.formatRecipients(msg.ccRecipients);
    const bcc = this.formatRecipients(msg.bccRecipients);

    const body = msg.body?.content || "";
    const labelIds = this.buildCanonicalLabels(msg);

    // Extract attachments
    const attachments: AttachmentMeta[] = (msg.attachments || [])
      .filter((a) => !a.isInline)
      .map((a) => ({
        id: a.id,
        filename: a.name,
        mimeType: a.contentType,
        size: a.size,
        attachmentId: a.id,
      }));

    // Extract headers for threading
    const headers = msg.internetMessageHeaders || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
    const messageIdHeader = msg.internetMessageId || getHeader("message-id");
    const inReplyTo = getHeader("in-reply-to");

    return {
      id: msg.id,
      threadId: msg.conversationId,
      subject: msg.subject || "",
      from,
      to,
      ...(cc && { cc }),
      ...(bcc && { bcc }),
      date: msg.receivedDateTime || msg.sentDateTime || "",
      body,
      snippet: msg.bodyPreview || "",
      labelIds,
      ...(attachments.length > 0 && { attachments }),
      ...(messageIdHeader && { messageIdHeader }),
      ...(inReplyTo && { inReplyTo }),
    };
  }

  /**
   * Convert a Graph message to a GmailDraft shape (used for draft listing).
   */
  private graphMessageToDraft(msg: GraphMessage): GmailDraft {
    return {
      id: msg.id,
      messageId: msg.id,
      threadId: msg.conversationId || undefined,
      to: (msg.toRecipients || []).map((r) => r.emailAddress.address),
      cc: (msg.ccRecipients || []).map((r) => r.emailAddress.address),
      bcc: (msg.bccRecipients || []).map((r) => r.emailAddress.address),
      subject: msg.subject || "",
      body: msg.body?.content || "",
      snippet: msg.bodyPreview || "",
    };
  }

  /**
   * Build a Graph message payload from ComposeMessageOptions.
   */
  private buildGraphMessage(options: ComposeMessageOptions): Record<string, unknown> {
    const message: Record<string, unknown> = {
      subject: options.subject,
      toRecipients: options.to.map((addr) => ({ emailAddress: { address: addr } })),
    };

    if (options.bodyHtml) {
      message.body = { contentType: "html", content: options.bodyHtml };
    } else {
      message.body = { contentType: "text", content: options.bodyText || "" };
    }

    if (options.cc?.length) {
      message.ccRecipients = options.cc.map((addr) => ({ emailAddress: { address: addr } }));
    }
    if (options.bcc?.length) {
      message.bccRecipients = options.bcc.map((addr) => ({ emailAddress: { address: addr } }));
    }

    return message;
  }
}
