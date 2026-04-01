import { useState, useEffect, useCallback } from "react";
import type { IpcResponse } from "../../shared/types";
import { reconfigurePostHog } from "../services/posthog";

interface SetupWizardProps {
  onComplete: () => void;
}

type Step =
  | "loading"
  | "provider"
  | "credentials"
  | "apikey"
  | "oauth"
  | "extensions"
  | "analytics";

type MailProviderType = "gmail" | "outlook";

interface ExtensionAuthInfo {
  extensionId: string;
  displayName: string;
  needsAuth: boolean;
  authType: "extension" | "agent";
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Track which steps are in the flow (determined at init)
  const [visibleSteps, setVisibleSteps] = useState<Step[]>([]);

  // Google OAuth credentials input
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");

  // API key input
  const [apiKey, setApiKey] = useState("");

  // Extension auth state
  const [extensionAuths, setExtensionAuths] = useState<ExtensionAuthInfo[]>([]);

  // Analytics opt-in (default ON — session replay is bundled under analytics)
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [authenticatingExtension, setAuthenticatingExtension] = useState<string | null>(null);

  // Provider selection
  const [selectedProvider, setSelectedProvider] = useState<MailProviderType>("gmail");
  // Which provider already has credentials saved (from check-auth)
  const [configuredProvider, setConfiguredProvider] = useState<MailProviderType | null>(null);

  // Asana Personal Access Token input
  const [asanaPat, setAsanaPat] = useState("");
  const [showAsanaTokenInput, setShowAsanaTokenInput] = useState<string | null>(null);

  // Check what's already configured and skip to the right step.
  useEffect(() => {
    (
      window.api.gmail.checkAuth() as Promise<
        IpcResponse<{
          hasCredentials: boolean;
          hasTokens: boolean;
          hasAnthropicKey: boolean;
          configuredProvider?: MailProviderType;
        }>
      >
    )
      .then((authResult) => {
        if (authResult.success) {
          const { hasCredentials, hasAnthropicKey, hasTokens, configuredProvider } =
            authResult.data;

          // Pre-select the provider that already has credentials saved
          if (configuredProvider) {
            setSelectedProvider(configuredProvider);
            setConfiguredProvider(configuredProvider);
          }

          const flow: Step[] = [];
          // Always show provider selection if OAuth hasn't completed yet —
          // the user may want to switch providers even if credentials exist.
          if (!hasTokens) flow.push("provider");
          // Always include credentials in flow when not fully authed —
          // the user might switch providers and need to enter new credentials.
          // The provider step's Continue button skips this dynamically if
          // the selected provider already has credentials.
          if (!hasTokens) flow.push("credentials");
          if (!hasAnthropicKey) flow.push("apikey");
          if (!hasTokens) flow.push("oauth");
          flow.push("extensions");
          flow.push("analytics");
          setVisibleSteps(flow);

          if (!hasTokens) {
            setStep("provider");
          } else if (!hasAnthropicKey) {
            setStep("apikey");
          } else {
            enterExtensionsStep();
          }
        } else {
          setVisibleSteps([
            "provider",
            "credentials",
            "apikey",
            "oauth",
            "extensions",
            "analytics",
          ]);
          setStep("provider");
        }
      })
      .catch(() => {
        setVisibleSteps(["provider", "credentials", "apikey", "oauth", "extensions", "analytics"]);
        setStep("provider");
      });
  }, []);

  const handleSaveCredentials = async () => {
    if (!googleClientId.trim() || !googleClientSecret.trim()) {
      setError("Both Client ID and Client Secret are required");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = (await window.api.gmail.saveCredentials(
        googleClientId.trim(),
        googleClientSecret.trim(),
        selectedProvider,
      )) as IpcResponse<void>;
      if (result.success) {
        const credIdx = visibleSteps.indexOf("credentials");
        const next = visibleSteps[credIdx + 1];
        if (next) {
          setStep(next);
        } else {
          setStep("apikey");
        }
      } else {
        setError(result.error ?? "Failed to save credentials");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) {
      setError("Please enter your Anthropic API key");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Validate the key with a real API call before saving
      const validation = (await window.api.settings.validateApiKey(
        apiKey.trim(),
      )) as IpcResponse<void>;
      if (!validation.success) {
        setError(validation.error ?? "Invalid API key");
        return;
      }

      const result = (await window.api.settings.set({
        anthropicApiKey: apiKey.trim(),
      })) as IpcResponse<void>;
      if (result.success) {
        const authResult = (await window.api.gmail.checkAuth()) as IpcResponse<{
          hasCredentials: boolean;
          hasTokens: boolean;
          hasAnthropicKey: boolean;
        }>;
        if (authResult.success && authResult.data.hasTokens) {
          await enterExtensionsStep();
        } else {
          setStep("oauth");
        }
      } else {
        setError(result.error ?? "Failed to save API key");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartOAuth = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.api.gmail.startOAuth(selectedProvider);
      if (result.success) {
        await enterExtensionsStep();
      } else {
        setError(result.error);
        setIsLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed. Please try again.");
      setIsLoading(false);
    }
  };

  const enterExtensionsStep = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = (await window.api.extensions.getPendingAuths()) as IpcResponse<
        ExtensionAuthInfo[]
      >;
      if (result.success && result.data.length > 0 && result.data.some((ext) => ext.needsAuth)) {
        setExtensionAuths(result.data.filter((ext) => ext.needsAuth));
        setStep("extensions");
        setIsLoading(false);
      } else {
        // No extensions need auth (or IPC failed) — skip extensions step entirely
        if (!result.success) {
          console.error("[SetupWizard] getPendingAuths failed:", result.error);
        }
        setVisibleSteps((prev) => prev.filter((s) => s !== "extensions"));
        setIsLoading(false);
        setStep("analytics");
      }
    } catch (err) {
      console.error("[SetupWizard] getPendingAuths failed:", err);
      setVisibleSteps((prev) => prev.filter((s) => s !== "extensions"));
      setIsLoading(false);
      setStep("analytics");
    }
  }, []);

  const handleExtensionAuth = async (extensionId: string, authType: "extension" | "agent") => {
    // For Asana, show the PAT input form instead of triggering OAuth
    if (extensionId === "asana" && authType === "extension" && !asanaPat.trim()) {
      setShowAsanaTokenInput(extensionId);
      return;
    }

    setAuthenticatingExtension(extensionId);
    setError(null);

    try {
      // If this is Asana with a PAT, save the token first then trigger auth check
      if (extensionId === "asana" && asanaPat.trim()) {
        const saveResult = (await window.api.extensions.saveSecrets(extensionId, {
          asana_access_token: asanaPat.trim(),
        })) as IpcResponse<void>;
        if (!saveResult.success) {
          setError(saveResult.error ?? "Failed to save Asana token");
          setAuthenticatingExtension(null);
          return;
        }
      }

      let success = false;
      if (authType === "agent") {
        const result = (await window.api.agent.authenticate(extensionId)) as IpcResponse<{
          success: boolean;
        }>;
        if (result.success) {
          success = result.data.success;
        }
        if (!success) {
          setError(
            !result.success
              ? (result.error ?? "Authentication failed")
              : "Authentication failed or was cancelled",
          );
        }
      } else {
        const result = (await window.api.extensions.authenticate(extensionId)) as IpcResponse<void>;
        success = result.success;
        if (!result.success) {
          setError(result.error ?? "Authentication failed");
        }
      }

      if (success) {
        setShowAsanaTokenInput(null);
        setExtensionAuths((prev) =>
          prev.map((ext) => (ext.extensionId === extensionId ? { ...ext, needsAuth: false } : ext)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setAuthenticatingExtension(null);
    }
  };

  // Step indicator — only show steps the user will actually visit
  const currentStepIndex = visibleSteps.indexOf(step);

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900">
      {/* Titlebar */}
      <div className="titlebar-drag h-12 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4">
        <div className="w-20" /> {/* Space for traffic lights */}
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Exo Setup</h1>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-xl w-full bg-white dark:bg-gray-800 rounded-xl shadow-lg dark:shadow-black/40 p-8">
          {step === "loading" && (
            <div className="flex justify-center">
              <div className="w-8 h-8 border-4 border-blue-200 dark:border-blue-800 border-t-blue-600 dark:border-t-blue-400 rounded-full animate-spin" />
            </div>
          )}

          {step === "provider" && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Choose Your Email Provider
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Exo supports both Gmail and Outlook. Select the provider you want to connect.
              </p>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <button
                  onClick={() => setSelectedProvider("gmail")}
                  className={`p-4 border-2 rounded-lg text-left transition-colors ${
                    selectedProvider === "gmail"
                      ? "border-blue-600 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/30"
                      : "border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700"
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <svg
                      className="w-6 h-6"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M22 6.5V17.5C22 18.88 20.88 20 19.5 20H4.5C3.12 20 2 18.88 2 17.5V6.5C2 5.12 3.12 4 4.5 4H19.5C20.88 4 22 5.12 22 6.5Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M22 6.5L12 13L2 6.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">Gmail</span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Connect your Google account
                  </p>
                </button>

                <button
                  onClick={() => setSelectedProvider("outlook")}
                  className={`p-4 border-2 rounded-lg text-left transition-colors ${
                    selectedProvider === "outlook"
                      ? "border-blue-600 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/30"
                      : "border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700"
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <svg
                      className="w-6 h-6"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M2 6.5V17.5C2 18.88 3.12 20 4.5 20H19.5C20.88 20 22 18.88 22 17.5V6.5C22 5.12 20.88 4 19.5 4H4.5C3.12 4 2 5.12 2 6.5Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M22 6.5L12 13L2 6.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">Outlook</span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Connect your Microsoft account
                  </p>
                </button>
              </div>

              <button
                onClick={() => {
                  // If the selected provider already has credentials saved, skip to the next step
                  if (selectedProvider === configuredProvider) {
                    const credIdx = visibleSteps.indexOf("credentials");
                    if (credIdx !== -1) {
                      // Skip credentials, go to the step after it
                      const next = visibleSteps[credIdx + 1];
                      setStep(next ?? "apikey");
                    } else {
                      // credentials not in flow, go to next after provider
                      const provIdx = visibleSteps.indexOf("provider");
                      const next = visibleSteps[provIdx + 1];
                      setStep(next ?? "apikey");
                    }
                  } else {
                    setStep("credentials");
                  }
                }}
                disabled={isLoading}
                className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                Continue
              </button>
            </>
          )}

          {step === "credentials" && (
            <>
              {selectedProvider === "gmail" ? (
                <>
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                    Google Cloud Credentials
                  </h2>
                  <p className="text-gray-600 dark:text-gray-400 mb-6">
                    Exo needs Google OAuth credentials to access your Gmail account. You'll need to
                    create a Google Cloud project with the Gmail API enabled.
                  </p>

                  <div className="bg-blue-50 dark:bg-blue-900/30 p-4 rounded-lg mb-6">
                    <h3 className="font-semibold text-blue-900 dark:text-blue-200 mb-2">
                      Setup steps:
                    </h3>
                    <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-2 list-decimal list-inside">
                      <li>
                        Go to the{" "}
                        <a
                          href="https://console.cloud.google.com/apis/credentials"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:no-underline"
                        >
                          Google Cloud Console
                        </a>
                      </li>
                      <li>Create a project (or select an existing one)</li>
                      <li>
                        Enable the <strong>Gmail API</strong> and{" "}
                        <strong>Google Calendar API</strong>
                      </li>
                      <li>Go to Credentials → Create Credentials → OAuth client ID</li>
                      <li>
                        Choose <strong>Desktop app</strong> as the application type
                      </li>
                      <li>Copy the Client ID and Client Secret below</li>
                    </ol>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                    Microsoft Azure AD Credentials
                  </h2>
                  <p className="text-gray-600 dark:text-gray-400 mb-6">
                    Exo needs Microsoft OAuth credentials to access your Outlook account. You'll
                    need to register an app in the Microsoft Entra admin center.
                  </p>

                  <div className="bg-blue-50 dark:bg-blue-900/30 p-4 rounded-lg mb-6">
                    <h3 className="font-semibold text-blue-900 dark:text-blue-200 mb-2">
                      Setup steps:
                    </h3>
                    <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-2 list-decimal list-inside">
                      <li>
                        Go to the{" "}
                        <a
                          href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:no-underline"
                        >
                          Microsoft Entra admin center
                        </a>
                      </li>
                      <li>Click "New registration"</li>
                      <li>
                        Enter an app name and select "Accounts in any organizational directory and
                        personal Microsoft accounts"
                      </li>
                      <li>
                        Set the redirect URI to <strong>msal&lt;client-id&gt;://auth</strong>{" "}
                        (you'll get the client ID after registration)
                      </li>
                      <li>Click "Register"</li>
                      <li>Copy the Application (client) ID below as Client ID</li>
                      <li>Go to "Certificates & secrets" → "New client secret"</li>
                      <li>Copy the secret value below as Client Secret</li>
                    </ol>
                  </div>
                </>
              )}

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Client ID
                  </label>
                  <input
                    type="text"
                    value={googleClientId}
                    onChange={(e) => setGoogleClientId(e.target.value)}
                    placeholder={
                      selectedProvider === "gmail"
                        ? "your-client-id.apps.google..."
                        : "your-application-client-id"
                    }
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Client Secret
                  </label>
                  <input
                    type="password"
                    value={googleClientSecret}
                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !isLoading && handleSaveCredentials()}
                    placeholder="your-client-secret"
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg mb-4">
                  <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
                </div>
              )}

              <button
                onClick={handleSaveCredentials}
                disabled={isLoading || !googleClientId.trim() || !googleClientSecret.trim()}
                className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                {isLoading ? "Saving..." : "Continue"}
              </button>
            </>
          )}

          {step === "apikey" && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Anthropic API Key
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Exo uses Claude to analyze your emails, generate drafts, and look up sender
                information. You'll need an Anthropic API key to enable these features.
              </p>

              <div className="bg-blue-50 dark:bg-blue-900/30 p-4 rounded-lg mb-6">
                <h3 className="font-semibold text-blue-900 dark:text-blue-200 mb-2">
                  Get your API key:
                </h3>
                <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-2 list-decimal list-inside">
                  <li>
                    Go to{" "}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:no-underline"
                    >
                      console.anthropic.com
                    </a>
                  </li>
                  <li>Create a new API key (or use an existing one)</li>
                  <li>Paste it below</li>
                </ol>
              </div>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Key
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !isLoading && handleSaveApiKey()}
                    placeholder="sk-ant-api03-..."
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg mb-4">
                  <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
                </div>
              )}

              <button
                onClick={handleSaveApiKey}
                disabled={isLoading}
                className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                {isLoading ? "Saving..." : "Continue"}
              </button>
            </>
          )}

          {step === "oauth" && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Authorize {selectedProvider === "gmail" ? "Gmail" : "Outlook"} Access
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Click the button below to authorize Exo to read your emails and create drafts. A
                browser window will open for you to sign in with{" "}
                {selectedProvider === "gmail" ? "Google" : "Microsoft"}.
              </p>

              <div className="bg-yellow-50 dark:bg-yellow-900/30 p-4 rounded-lg mb-6">
                <h3 className="font-semibold text-yellow-900 dark:text-yellow-200 mb-2">
                  Permissions requested:
                </h3>
                <ul className="text-sm text-yellow-800 dark:text-yellow-300 space-y-1 list-disc list-inside">
                  {selectedProvider === "gmail" ? (
                    <>
                      <li>Read your emails (gmail.readonly)</li>
                      <li>Create draft emails (gmail.compose)</li>
                      <li>View your calendar events (calendar.readonly)</li>
                    </>
                  ) : (
                    <>
                      <li>Read your emails (Mail.Read)</li>
                      <li>Send emails on your behalf (Mail.Send)</li>
                      <li>Create draft emails (Mail.ReadWrite)</li>
                      <li>Read your profile (User.Read)</li>
                    </>
                  )}
                </ul>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg mb-4">
                  <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
                </div>
              )}

              <button
                onClick={handleStartOAuth}
                disabled={isLoading}
                className="w-full py-3 bg-green-600 dark:bg-green-500 text-white font-medium rounded-lg hover:bg-green-700 dark:hover:bg-green-600 transition-colors disabled:opacity-50"
              >
                {isLoading
                  ? "Authorizing..."
                  : `Authorize with ${selectedProvider === "gmail" ? "Google" : "Microsoft"}`}
              </button>
            </>
          )}

          {step === "extensions" && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Connect Services
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Some extensions need authentication to enrich your emails. You can connect them now
                or later.
              </p>

              <div className="space-y-3 mb-6">
                {extensionAuths.map((ext) => (
                  <div
                    key={ext.extensionId}
                    className="border border-gray-200 dark:border-gray-600 rounded-lg"
                  >
                    <div className="flex items-center justify-between p-4">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {ext.displayName}
                      </span>
                      {ext.needsAuth ? (
                        <button
                          onClick={() => handleExtensionAuth(ext.extensionId, ext.authType)}
                          disabled={authenticatingExtension !== null}
                          className="px-4 py-1.5 text-sm bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
                        >
                          {authenticatingExtension === ext.extensionId ? (
                            <span className="flex items-center gap-2">
                              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              Connecting...
                            </span>
                          ) : (
                            "Login"
                          )}
                        </button>
                      ) : (
                        <span className="text-green-600 dark:text-green-400 flex items-center gap-1.5">
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Connected
                        </span>
                      )}
                    </div>

                    {/* Asana PAT input — shown when user clicks Login */}
                    {showAsanaTokenInput === ext.extensionId && (
                      <div className="px-4 pb-4 space-y-3 border-t border-gray-200 dark:border-gray-600 pt-3">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Go to{" "}
                          <a
                            href="https://app.asana.com/0/my-apps"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 dark:text-blue-400 underline hover:no-underline"
                          >
                            app.asana.com/0/my-apps
                          </a>{" "}
                          and create a Personal Access Token.
                        </p>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Personal Access Token
                          </label>
                          <input
                            type="password"
                            value={asanaPat}
                            onChange={(e) => setAsanaPat(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" &&
                              asanaPat.trim() &&
                              handleExtensionAuth(ext.extensionId, ext.authType)
                            }
                            placeholder="1/12345678901234:abc..."
                            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        </div>
                        <button
                          onClick={() => handleExtensionAuth(ext.extensionId, ext.authType)}
                          disabled={!asanaPat.trim() || authenticatingExtension !== null}
                          className="w-full py-2 text-sm bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
                        >
                          {authenticatingExtension === ext.extensionId
                            ? "Connecting..."
                            : "Connect Asana"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg mb-4">
                  <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
                </div>
              )}

              <button
                onClick={() => setStep("analytics")}
                disabled={authenticatingExtension !== null}
                className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                Continue
              </button>
            </>
          )}

          {step === "analytics" && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                Help Improve Exo
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                We collect usage data and error reports to improve the app. No email content is ever
                sent — only app interactions and crash diagnostics. Your email address is sent so we
                can identify you in error reports. You can change this anytime in Settings.
              </p>

              <label className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-600 rounded-lg cursor-pointer mb-6">
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    Usage Analytics
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    Crash reports, app usage data, and session recordings for debugging
                  </div>
                </div>
                <div
                  role="switch"
                  aria-checked={analyticsEnabled}
                  onClick={() => setAnalyticsEnabled(!analyticsEnabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    analyticsEnabled
                      ? "bg-blue-600 dark:bg-blue-500"
                      : "bg-gray-300 dark:bg-gray-600"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      analyticsEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </div>
              </label>

              <button
                onClick={async () => {
                  setIsLoading(true);
                  try {
                    // Session replay is bundled with analytics — both on or both off
                    const result = (await window.api.settings.set({
                      posthog: { enabled: analyticsEnabled, sessionReplay: analyticsEnabled },
                    })) as IpcResponse<void>;
                    if (!result.success) {
                      console.error("[SetupWizard] Failed to save analytics config");
                      // Analytics save failure is non-critical — still complete wizard
                    }
                    // Only reconfigure if save succeeded — prevents runtime/persisted state divergence
                    const apiKey = import.meta.env.VITE_POSTHOG_API_KEY;
                    const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
                    if (apiKey && result.success) {
                      reconfigurePostHog({
                        enabled: analyticsEnabled,
                        apiKey,
                        host,
                        sessionReplay: analyticsEnabled,
                      });
                    }
                    onComplete();
                  } finally {
                    setIsLoading(false);
                  }
                }}
                disabled={isLoading}
                className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                Get Started
              </button>
            </>
          )}

          {/* Step indicator — only shows steps the user will actually visit */}
          {step !== "loading" && visibleSteps.length > 0 && (
            <div className="flex justify-center gap-2 mt-6">
              {visibleSteps.map((s, i) => (
                <div
                  key={s}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i <= currentStepIndex
                      ? "bg-blue-600 dark:bg-blue-400"
                      : "bg-gray-300 dark:bg-gray-600"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
