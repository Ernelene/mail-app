/**
 * Asana API client with OAuth2 authentication.
 *
 * Supports both the full OAuth2 authorization code grant flow (with PKCE)
 * and personal access tokens stored in extension secrets.
 */

import type { ExtensionContext } from "../../../shared/extension-types";
import { createServer, type Server } from "http";
import { shell } from "electron";
import { randomBytes, createHash } from "crypto";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const ASANA_AUTH_URL = "https://app.asana.com/-/oauth_authorize";
const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";

const REDIRECT_PORT = 3849;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// Bundled at build time via MAIN_VITE_ASANA_CLIENT_ID / MAIN_VITE_ASANA_CLIENT_SECRET.
// When set, users just click "Login" without needing to register an Asana app.
const _asanaClientId = import.meta.env.MAIN_VITE_ASANA_CLIENT_ID ?? "";
const _asanaClientSecret = import.meta.env.MAIN_VITE_ASANA_CLIENT_SECRET ?? "";
const BUNDLED_ASANA_CREDENTIALS: { client_id: string; client_secret: string } | null =
  _asanaClientId ? { client_id: _asanaClientId, client_secret: _asanaClientSecret } : null;

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

interface AsanaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ────────────────────────────────────────
// Client
// ────────────────────────────────────────

export class AsanaClient {
  private context: ExtensionContext;
  private accessToken: string | null = null;

  // OAuth server lifecycle — mirrors Gmail/Outlook pattern
  private pendingOAuthServer: Server | null = null;
  private pendingOAuthReject: ((reason: Error) => void) | null = null;
  private pendingOAuthTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(context: ExtensionContext) {
    this.context = context;
  }

  // ── Token management ──

  /**
   * Load the access token from extension secrets.
   * If the token is expired but we have a refresh token, refresh it first.
   */
  async loadToken(): Promise<boolean> {
    const storedTokens = await this.context.secrets.get("asana_tokens");
    if (storedTokens) {
      const tokens: AsanaTokens = JSON.parse(storedTokens);

      // Check if access token is expired (with 5-minute buffer)
      if (tokens.expires_at < Date.now() - 5 * 60 * 1000) {
        const clientId =
          BUNDLED_ASANA_CREDENTIALS?.client_id ||
          (await this.context.secrets.get("asana_client_id"));
        const clientSecret =
          BUNDLED_ASANA_CREDENTIALS?.client_secret ||
          (await this.context.secrets.get("asana_client_secret"));
        if (clientId && clientSecret && tokens.refresh_token) {
          try {
            await this.refreshAccessToken(tokens.refresh_token, clientId, clientSecret);
            return true;
          } catch {
            this.context.logger.warn("Failed to refresh Asana token, need re-auth");
            return false;
          }
        }
        return false;
      }

      this.accessToken = tokens.access_token;
      return true;
    }

    // Fallback: check for legacy PAT-style token
    const pat = await this.context.secrets.get("asana_access_token");
    if (pat) {
      this.accessToken = pat;
      return true;
    }

    return false;
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

  // ── OAuth2 flow ──

  /**
   * Run the full OAuth2 authorization code grant flow with PKCE.
   * Opens the user's browser for Asana authorization, then exchanges
   * the code for tokens via a local HTTP server callback.
   */
  async doOAuthFlow(): Promise<void> {
    // Clean up any leftover server from a previous attempt
    this.abortOAuth();

    // Resolve credentials: bundled at build time, or manually entered by user
    const clientId =
      BUNDLED_ASANA_CREDENTIALS?.client_id ||
      (await this.context.secrets.get("asana_client_id"));
    const clientSecret =
      BUNDLED_ASANA_CREDENTIALS?.client_secret ||
      (await this.context.secrets.get("asana_client_secret"));

    if (!clientId || !clientSecret) {
      throw new Error(
        "Asana OAuth credentials not configured. " +
          "Register an app at https://app.asana.com/0/my-apps and enter the client ID and secret.",
      );
    }

    // PKCE: generate code_verifier and code_challenge
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(16).toString("hex");

    const authUrl = new URL(ASANA_AUTH_URL);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    this.context.logger.info("Opening browser for Asana authorization...");
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
        const returnedState = url.searchParams.get("state");

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end("State mismatch — possible CSRF attack. Please try again.");
          server.closeAllConnections();
          server.close();
          cleanup();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        if (authCode) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                  <h1>Exo Connected (Asana)</h1>
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

      // Handle listen errors (e.g. port already in use)
      server.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `OAuth callback port ${REDIRECT_PORT} is already in use. ` +
                "Please close any other Exo instances and try again.",
            ),
          );
        } else {
          reject(new Error(`OAuth server error: ${err.message}`));
        }
      });

      this.pendingOAuthServer = server;
      this.pendingOAuthReject = (reason: Error) => {
        server.closeAllConnections();
        server.close();
        cleanup();
        reject(reason);
      };

      server.listen(REDIRECT_PORT, () => {
        this.context.logger.info("Waiting for Asana authorization callback...");
      });

      // Timeout after 5 minutes
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
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: codeVerifier,
    });

    const resp = await fetch(ASANA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Asana token exchange failed: ${resp.status} ${errBody}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: AsanaTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    // Store tokens and credentials for future refresh
    await this.context.secrets.set("asana_tokens", JSON.stringify(tokens));
    this.accessToken = tokens.access_token;

    this.context.logger.info("Asana OAuth2 authentication successful");
  }

  /**
   * Cancel an in-progress OAuth flow.
   */
  abortOAuth(): void {
    if (this.pendingOAuthServer) {
      this.pendingOAuthServer.closeAllConnections();
      this.pendingOAuthServer.close();
      this.pendingOAuthServer = null;
    }
    if (this.pendingOAuthTimeout) {
      clearTimeout(this.pendingOAuthTimeout);
      this.pendingOAuthTimeout = null;
    }
    if (this.pendingOAuthReject) {
      this.pendingOAuthReject(new Error("Authorization cancelled"));
      this.pendingOAuthReject = null;
    }
  }

  /**
   * Store OAuth client credentials for use during the OAuth flow.
   */
  async setOAuthCredentials(clientId: string, clientSecret: string): Promise<void> {
    await this.context.secrets.set("asana_client_id", clientId);
    await this.context.secrets.set("asana_client_secret", clientSecret);
  }

  /**
   * Check if OAuth client credentials are configured (bundled or manually entered).
   */
  async hasOAuthCredentials(): Promise<boolean> {
    if (BUNDLED_ASANA_CREDENTIALS) return true;
    const clientId = await this.context.secrets.get("asana_client_id");
    return clientId !== null;
  }

  // ── Token refresh ──

  private async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    const resp = await fetch(ASANA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Asana token refresh failed: ${resp.status} ${errBody}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const tokens: AsanaTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    await this.context.secrets.set("asana_tokens", JSON.stringify(tokens));
    this.accessToken = tokens.access_token;

    this.context.logger.info("Asana access token refreshed");
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

  /**
   * Update an existing task by GID.
   */
  async updateTask(
    taskGid: string,
    params: {
      name?: string;
      notes?: string;
      assignee?: string;
      due_on?: string | null;
      completed?: boolean;
    },
  ): Promise<AsanaTask> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body.name = params.name;
    if (params.notes !== undefined) body.notes = params.notes;
    if (params.assignee !== undefined) body.assignee = params.assignee;
    if (params.due_on !== undefined) body.due_on = params.due_on;
    if (params.completed !== undefined) body.completed = params.completed;

    const data = await this.put<{ data: AsanaTask }>(`/tasks/${taskGid}`, { data: body });
    return data.data;
  }

  /**
   * Add a comment/story to a task.
   */
  async addTaskComment(taskGid: string, text: string): Promise<void> {
    await this.post(`/tasks/${taskGid}/stories`, { data: { text } });
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

  private async put<T>(path: string, body: unknown): Promise<T> {
    if (!this.accessToken) throw new Error("Not authenticated with Asana");
    const url = path.startsWith("http") ? path : `${ASANA_API_BASE}${path}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text();
      const err = new Error(`Asana PUT ${path} failed: ${resp.status} ${respBody}`);
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
