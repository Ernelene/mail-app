/**
 * Asana Extension for Exo Mail Client.
 *
 * Provides:
 *   - Sidebar enrichment panel showing linked Asana tasks for each email
 *   - Task creation from emails (via enrichment data)
 *   - OAuth2 authentication with Asana
 */

import type {
  ExtensionContext,
  ExtensionAPI,
  ExtensionModule,
} from "../../../shared/extension-types";
import { AsanaClient } from "./asana-client";
import { createAsanaEnrichmentProvider } from "./asana-enrichment-provider";

const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating Asana extension");

    const asanaClient = new AsanaClient(context);

    // Register auth handler so the extension host can trigger auth when needed.
    // For the initial version, we support personal access tokens (PAT) entered
    // by the user in settings. Full OAuth2 can be added later.
    api.registerAuthHandler(
      async () => {
        // This handler is invoked when the user clicks "Authenticate" on the
        // extension auth banner. For now, we check if a token was already set
        // in secrets (e.g. via settings UI) and validate it.
        const loaded = await asanaClient.loadToken();
        if (!loaded) {
          throw new Error(
            "No Asana token found. Add your Personal Access Token in Settings → Extensions → Asana.",
          );
        }
        const valid = await asanaClient.isAuthenticated();
        if (!valid) {
          throw new Error("Asana token is invalid or expired. Please update it in Settings.");
        }
        context.logger.info("Asana authentication verified");
      },
      {
        checkAuth: async () => {
          return asanaClient.isAuthenticated();
        },
      },
    );

    // Register enrichment provider
    const provider = createAsanaEnrichmentProvider(context, api, asanaClient);
    api.registerEnrichmentProvider(provider);

    context.logger.info("Asana extension activated");
  },

  async deactivate(): Promise<void> {
    // No cleanup needed
  },
};

export const { activate, deactivate } = extension;
