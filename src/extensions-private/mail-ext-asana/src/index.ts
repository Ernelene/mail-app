/**
 * Asana Extension for Exo Mail Client.
 *
 * Provides:
 *   - Sidebar enrichment panel showing linked Asana tasks for each email
 *   - Task creation from emails (via enrichment data)
 *   - Authentication via Personal Access Token (PAT)
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

    // Register auth handler — verifies the stored PAT when the user
    // clicks "Login" on the extension auth banner or in the setup wizard.
    // The PAT is saved to extension secrets by the SetupWizard before
    // this handler is called.
    api.registerAuthHandler(
      async () => {
        const loaded = await asanaClient.loadToken();
        if (!loaded) {
          throw new Error(
            "No Asana token found. Enter your Personal Access Token to connect.",
          );
        }
        const valid = await asanaClient.isAuthenticated();
        if (!valid) {
          throw new Error("Asana token is invalid or expired. Please check your token and try again.");
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
