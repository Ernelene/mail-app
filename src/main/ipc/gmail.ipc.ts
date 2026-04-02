import { ipcMain } from "electron";
import { GmailClient } from "../services/gmail-client";
import { OutlookClient } from "../services/outlook-client";
import type { MailProvider, MailProviderType } from "../services/mail-provider";
import { createMailProvider } from "../services/provider-factory";
import { saveEmail, getEmailIds, getInboxEmails, getEmail, saveAccount, getAccounts } from "../db";
import { getConfig } from "./settings.ipc";
import type { IpcResponse, DashboardEmail } from "../../shared/types";
import { DEMO_INBOX_EMAILS, DEMO_EXPECTED_ANALYSIS } from "../demo/fake-inbox";
import { createLogger } from "../services/logger";

const log = createLogger("gmail-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

const mailClients = new Map<string, MailProvider>();

function resolveTargetAccountId(accountId?: string): string {
  const trimmedAccountId = accountId?.trim();
  const accounts = getAccounts();

  if (trimmedAccountId && accounts.some((account) => account.id === trimmedAccountId)) {
    return trimmedAccountId;
  }

  const fallbackAccount = accounts.find((account) => account.isPrimary) ?? accounts[0];
  const fallbackId = fallbackAccount?.id ?? "default";

  if (trimmedAccountId) {
    log.warn(
      `[Gmail] Requested account "${trimmedAccountId}" not found, falling back to "${fallbackId}"`,
    );
  }

  return fallbackId;
}

export async function getClient(accountId = "default"): Promise<MailProvider> {
  const existing = mailClients.get(accountId);
  if (existing) {
    return existing;
  }

  // Look up account's provider type from DB; default to gmail for backward compat
  const accounts = getAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const providerType = account?.provider || "gmail";

  const client = createMailProvider(accountId, providerType);
  await client.connect();
  mailClients.set(accountId, client);
  return client;
}

export function registerGmailIpc(): void {
  // Check authentication status
  ipcMain.handle(
    "gmail:check-auth",
    async (): Promise<
      IpcResponse<{
        hasCredentials: boolean;
        hasTokens: boolean;
        hasAnthropicKey: boolean;
        configuredProvider?: "gmail" | "outlook";
      }>
    > => {
      // In demo/test mode, always return authenticated
      if (useFakeData) {
        return {
          success: true,
          data: {
            hasCredentials: true,
            hasTokens: true,
            hasAnthropicKey: true,
          },
        };
      }

      try {
        // Check both Gmail and Outlook credentials
        const gmailClient = new GmailClient();
        const outlookClient = new OutlookClient();
        // Check for either an explicit API key or Claude Code OAuth login
        const { readClaudeOAuthToken } = await import("../services/anthropic-service");
        const hasAnthropicKey = !!(
          process.env.ANTHROPIC_API_KEY ||
          getConfig().anthropicApiKey ||
          readClaudeOAuthToken()
        );

        const gmailHasCredentials = gmailClient.hasCredentials();
        const outlookHasCredentials = outlookClient.hasCredentials();
        const hasCredentials = gmailHasCredentials || outlookHasCredentials;

        // Check tokens - if any account exists with tokens, we consider authenticated
        const gmailHasTokens = gmailClient.hasTokens();
        const outlookHasTokens = outlookClient.hasTokens();
        const hasTokens = gmailHasTokens || outlookHasTokens;

        // Report which provider has credentials so the renderer can pre-select it
        const configuredProvider: "gmail" | "outlook" | undefined = outlookHasCredentials
          ? "outlook"
          : gmailHasCredentials
            ? "gmail"
            : undefined;

        return {
          success: true,
          data: {
            hasCredentials,
            hasTokens,
            hasAnthropicKey,
            configuredProvider,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Save credentials
  ipcMain.handle(
    "gmail:save-credentials",
    async (
      _,
      {
        clientId,
        clientSecret,
        providerType,
      }: { clientId: string; clientSecret: string; providerType?: MailProviderType },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        // Default to gmail for backward compatibility
        const resolvedProvider: MailProviderType = providerType || "gmail";
        const client = createMailProvider("default", resolvedProvider);
        await client.saveCredentials(clientId, clientSecret);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Start OAuth flow
  ipcMain.handle(
    "gmail:start-oauth",
    async (
      _,
      { providerType }: { providerType?: MailProviderType },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        // Reset clients to force re-auth
        mailClients.clear();

        // Use provided provider type or default to gmail for backward compatibility
        const resolvedProvider: MailProviderType = providerType || "gmail";
        const client = createMailProvider("default", resolvedProvider);
        await client.connect();

        // Store client for reuse
        mailClients.set("default", client);

        // Get the user's profile to save the account
        const profile = await client.getProfile();
        const accountId = client.getAccountId();

        // Save the account to the database if not already saved
        const existingAccounts = getAccounts();
        const alreadyExists = existingAccounts.some(
          (a) => a.id === accountId || a.email === profile.emailAddress,
        );

        if (!alreadyExists) {
          const displayName = await client.fetchDisplayName();
          const isPrimary = existingAccounts.length === 0;
          // Save account with the correct provider type
          saveAccount(
            accountId,
            profile.emailAddress,
            displayName ?? undefined,
            isPrimary,
            resolvedProvider,
          );
          log.info(
            `[OAuth] Saved new account: ${profile.emailAddress} (${accountId}, provider: ${resolvedProvider})`,
          );
        }

        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Fetch emails (all inbox or demo data)
  ipcMain.handle(
    "gmail:fetch-unread",
    async (
      _,
      { maxResults, accountId }: { maxResults?: number; accountId?: string },
    ): Promise<IpcResponse<DashboardEmail[]>> => {
      // In demo/test mode, return fake emails merged with DB state (drafts, analysis)
      if (useFakeData) {
        const currentInbox = getInboxEmails(accountId || "default");
        const dbMap = new Map(currentInbox.map((e) => [e.id, e]));
        const fakeEmails: DashboardEmail[] = DEMO_INBOX_EMAILS.slice(0, maxResults || 100)
          .filter((email) => dbMap.has(email.id))
          .map((email) => {
            const dbEmail = dbMap.get(email.id)!;
            const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[email.id];
            return {
              ...email,
              accountId: accountId || "default",
              analysis:
                dbEmail.analysis ??
                (expectedAnalysis
                  ? {
                      needsReply: expectedAnalysis.needsReply,
                      reason: expectedAnalysis.reason,
                      priority: expectedAnalysis.priority,
                      analyzedAt: Date.now(),
                    }
                  : undefined),
              draft: dbEmail.draft,
            };
          });
        return { success: true, data: fakeEmails };
      }

      try {
        const resolvedAccountId = resolveTargetAccountId(accountId);
        const client = await getClient(resolvedAccountId);

        // Search for all emails in inbox (most recent first)
        const { results: searchResults } = await client.searchEmails("in:inbox", maxResults || 100);

        // Get existing email IDs from DB (fast - just IDs, not full emails)
        const existingIds = getEmailIds(resolvedAccountId);

        // Fetch full email content for new emails only
        let newEmailCount = 0;
        for (const result of searchResults) {
          if (!existingIds.has(result.id)) {
            const email = await client.readEmail(result.id);
            if (email) {
              saveEmail(email, resolvedAccountId);
              newEmailCount++;
            }
          }
        }

        if (newEmailCount > 0) {
          log.info(`[Gmail] Fetched ${newEmailCount} new emails`);
        }

        // Get ALL inbox emails from DB (not just the ones from this API call)
        // Return ALL inbox emails from DB (not just the ones from this API call)
        // Analysis is handled by the prefetch service via processAllPending()
        return { success: true, data: getInboxEmails(resolvedAccountId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get single email
  ipcMain.handle(
    "gmail:get-email",
    async (_, { emailId }: { emailId: string }): Promise<IpcResponse<DashboardEmail>> => {
      // In demo mode, find from fake emails
      if (useFakeData) {
        const email = DEMO_INBOX_EMAILS.find((e) => e.id === emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }
        const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[email.id];
        return {
          success: true,
          data: {
            ...email,
            analysis: expectedAnalysis
              ? {
                  needsReply: expectedAnalysis.needsReply,
                  reason: expectedAnalysis.reason,
                  priority: expectedAnalysis.priority,
                  analyzedAt: Date.now(),
                }
              : undefined,
          },
        };
      }

      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }
        return { success: true, data: email };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Create draft in Gmail
  ipcMain.handle(
    "gmail:create-draft",
    async (
      _,
      {
        emailId,
        body,
        cc,
        bcc,
        accountId,
      }: { emailId: string; body: string; cc?: string[]; bcc?: string[]; accountId?: string },
    ): Promise<IpcResponse<{ draftId: string }>> => {
      // In demo mode, simulate draft creation
      if (useFakeData) {
        log.info(`[DEMO] Creating draft for email ${emailId}`);
        log.info(`[DEMO] Draft body: ${body.substring(0, 100)}...`);
        if (cc?.length) {
          log.info(`[DEMO] CC: ${cc.join(", ")}`);
        }
        if (bcc?.length) {
          log.info(`[DEMO] BCC: ${bcc.join(", ")}`);
        }
        return { success: true, data: { draftId: `demo-draft-${Date.now()}` } };
      }

      try {
        const resolvedAccountId = resolveTargetAccountId(accountId);
        const client = await getClient(resolvedAccountId);
        const email = getEmail(emailId);

        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const fromMatch = email.from.match(/<([^>]+)>/);
        const replyTo = fromMatch ? fromMatch[1] : email.from;

        // Format subject
        const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

        const result = await client.createDraft({
          to: replyTo,
          subject,
          body,
          threadId: email.threadId,
          cc,
          bcc,
        });

        // Update draft in database
        const { updateDraftStatus } = await import("../db");
        updateDraftStatus(emailId, "created", result.id);

        return { success: true, data: { draftId: result.id } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
