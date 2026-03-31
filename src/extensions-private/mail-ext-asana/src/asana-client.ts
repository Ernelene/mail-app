/**
 * Thin wrapper around the Asana REST API v1.
 *
 * Uses personal access tokens or OAuth2 tokens stored in extension secrets.
 * All methods throw on HTTP errors with descriptive messages.
 */

import type { ExtensionContext } from "../../../shared/extension-types";
const ASANA_API_BASE = "https://app.asana.com/api/1.0";

// ────────────────────────────────────────
// Types
// ────────────────────────────────────────

export interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  assignee: { gid: string; name: string } | null;
  due_on: string | null;
  permalink_url: string;
  notes: string;
  projects: Array<{ gid: string; name: string }>;
}

export interface AsanaWorkspace {
  gid: string;
  name: string;
}

export interface AsanaProject {
  gid: string;
  name: string;
}

// ────────────────────────────────────────
// Client
// ────────────────────────────────────────

export class AsanaClient {
  private context: ExtensionContext;
  private accessToken: string | null = null;

  constructor(context: ExtensionContext) {
    this.context = context;
  }

  /**
   * Load the access token from extension secrets.
   * Returns true if a token was found.
   */
  async loadToken(): Promise<boolean> {
    this.accessToken = await this.context.secrets.get("asana_access_token");
    return this.accessToken !== null;
  }

  /**
   * Store a new access token (from OAuth or manual PAT entry).
   */
  async setToken(token: string): Promise<void> {
    this.accessToken = token;
    await this.context.secrets.set("asana_access_token", token);
  }

  /**
   * Check if we have a valid token by hitting /users/me.
   */
  async isAuthenticated(): Promise<boolean> {
    if (!this.accessToken) {
      const loaded = await this.loadToken();
      if (!loaded) return false;
    }
    try {
      await this.get("/users/me");
      return true;
    } catch {
      return false;
    }
  }

  // ── Workspaces ──

  async listWorkspaces(): Promise<AsanaWorkspace[]> {
    const data = await this.get<{ data: AsanaWorkspace[] }>("/workspaces?opt_fields=name");
    return data.data;
  }

  // ── Tasks ──

  /**
   * Search for tasks in a workspace matching a text query.
   */
  async searchTasks(
    workspaceGid: string,
    query: string,
    maxResults: number = 10,
  ): Promise<AsanaTask[]> {
    const params = new URLSearchParams({
      text: query,
      opt_fields: "name,completed,assignee.name,due_on,permalink_url,notes,projects.name",
      limit: String(maxResults),
    });
    const data = await this.get<{ data: AsanaTask[] }>(
      `/workspaces/${workspaceGid}/tasks/search?${params}`,
    );
    return data.data;
  }

  /**
   * Get a single task by GID.
   */
  async getTask(taskGid: string): Promise<AsanaTask> {
    const data = await this.get<{ data: AsanaTask }>(
      `/tasks/${taskGid}?opt_fields=name,completed,assignee.name,due_on,permalink_url,notes,projects.name`,
    );
    return data.data;
  }

  /**
   * Create a new task in a workspace.
   */
  async createTask(params: {
    workspaceGid: string;
    name: string;
    notes?: string;
    assignee?: string;
    due_on?: string;
    projects?: string[];
  }): Promise<AsanaTask> {
    const body: Record<string, unknown> = {
      workspace: params.workspaceGid,
      name: params.name,
    };
    if (params.notes) body.notes = params.notes;
    if (params.assignee) body.assignee = params.assignee;
    if (params.due_on) body.due_on = params.due_on;
    if (params.projects?.length) body.projects = params.projects;

    const data = await this.post<{ data: AsanaTask }>("/tasks", { data: body });
    return data.data;
  }

  // ── HTTP helpers ──

  private async get<T>(path: string): Promise<T> {
    if (!this.accessToken) throw new Error("Not authenticated with Asana");
    const url = path.startsWith("http") ? path : `${ASANA_API_BASE}${path}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      const err = new Error(`Asana GET ${path} failed: ${resp.status} ${body}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.accessToken) throw new Error("Not authenticated with Asana");
    const url = path.startsWith("http") ? path : `${ASANA_API_BASE}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text();
      const err = new Error(`Asana POST ${path} failed: ${resp.status} ${respBody}`);
      (err as Record<string, unknown>).status = resp.status;
      throw err;
    }
    return resp.json() as Promise<T>;
  }
}
