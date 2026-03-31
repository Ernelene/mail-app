/**
 * Factory for creating mail provider instances based on provider type.
 */

import { GmailClient } from "./gmail-client";
import { OutlookClient } from "./outlook-client";
import type { MailProvider, MailProviderType } from "./mail-provider";

/**
 * Create a MailProvider instance for the given account and provider type.
 *
 * Defaults to "gmail" for backward compatibility with existing accounts
 * that don't have a provider column in the database.
 */
export function createMailProvider(
  accountId: string,
  providerType: MailProviderType = "gmail",
): MailProvider {
  switch (providerType) {
    case "gmail":
      return new GmailClient(accountId);
    case "outlook":
      return new OutlookClient(accountId);
    default: {
      // Exhaustive check — TypeScript will error if a new provider type is added
      // without handling it here.
      const _exhaustive: never = providerType;
      throw new Error(`Unknown mail provider type: ${_exhaustive}`);
    }
  }
}
