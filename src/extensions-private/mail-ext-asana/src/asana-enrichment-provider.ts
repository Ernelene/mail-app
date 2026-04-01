/**
 * Asana enrichment provider.
 *
 * For each email, searches Asana for tasks that match by:
 *   1. Asana task URLs found in the email body (direct link match)
 *   2. Subject line text search
 *
 * Results are cached via the extension enrichment store.
 */

import type {
  ExtensionContext,
  ExtensionAPI,
  EnrichmentProvider,
  EnrichmentData,
} from "../../../shared/extension-types";
import type { DashboardEmail } from "../../../shared/types";
import type { AsanaClient, AsanaTask } from "./asana-client";

// Match both old and new Asana URL formats:
//   Old: https://app.asana.com/0/{project_gid}/{task_gid}
//   New: https://app.asana.com/1/{workspace_gid}/project/{project_gid}/task/{task_gid}
const ASANA_TASK_URL_RE =
  /https:\/\/app\.asana\.com\/(?:0\/\d+\/(\d+)|1\/\d+\/project\/\d+\/task\/(\d+))/g;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createAsanaEnrichmentProvider(
  context: ExtensionContext,
  api: ExtensionAPI,
  asanaClient: AsanaClient,
): EnrichmentProvider {
  return {
    id: "asana-tasks",
    panelId: "asana-tasks",
    priority: 50,

    canEnrich(_email: DashboardEmail): boolean {
      // We always attempt enrichment — the search is fast and cached.
      // Auth failures are handled gracefully in enrich().
      return true;
    },

    async enrich(
      email: DashboardEmail,
      _threadEmails: DashboardEmail[],
    ): Promise<EnrichmentData | null> {
      // Check authentication
      const isAuthed = await asanaClient.isAuthenticated();
      if (!isAuthed) {
        api.emitAuthRequired("Asana authentication required");
        return null;
      }

      // Get workspace GID from settings
      const workspaceGid = await api.getSetting<string>("workspace_id");
      if (!workspaceGid) {
        context.logger.warn("No Asana workspace configured — skipping enrichment");
        return null;
      }

      const tasks: AsanaTask[] = [];
      const seenGids = new Set<string>();

      // Strategy 1: Extract Asana task URLs from email body
      if (email.body) {
        const urlMatches = [...email.body.matchAll(ASANA_TASK_URL_RE)];
        for (const match of urlMatches) {
          const taskGid = match[1] || match[2];
          if (seenGids.has(taskGid)) continue;
          seenGids.add(taskGid);
          try {
            const task = await asanaClient.getTask(taskGid);
            tasks.push(task);
          } catch (err) {
            context.logger.warn(`Failed to fetch Asana task ${taskGid}: ${err}`);
          }
        }
      }

      // Strategy 2: Search by email subject (only if no URL matches found)
      if (tasks.length === 0 && email.subject) {
        // Clean the subject: strip "Re:", "Fwd:", etc.
        const cleanSubject = email.subject.replace(/^(Re|Fwd|Fw):\s*/gi, "").trim();
        if (cleanSubject.length >= 3) {
          try {
            const searchResults = await asanaClient.searchTasks(workspaceGid, cleanSubject, 5);
            for (const task of searchResults) {
              if (!seenGids.has(task.gid)) {
                seenGids.add(task.gid);
                tasks.push(task);
              }
            }
          } catch (err) {
            context.logger.warn(`Asana search failed for "${cleanSubject}": ${err}`);
          }
        }
      }

      if (tasks.length === 0) return null;

      return {
        extensionId: "asana",
        panelId: "asana-tasks",
        data: {
          tasks: tasks.map((t) => ({
            gid: t.gid,
            name: t.name,
            completed: t.completed,
            assignee: t.assignee?.name || null,
            dueOn: t.due_on,
            url: t.permalink_url,
            projectName: t.projects?.[0]?.name || null,
          })),
          emailSubject: email.subject,
          workspaceGid,
        },
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
    },
  };
}
