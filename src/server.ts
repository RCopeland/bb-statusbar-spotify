// bb-plugin-statusbar-spotify — a Spotify section for the Statusbar plugin.
//
// WHAT THIS IS
//
// A status-bar section provider. It publishes the section protocol's
// `section.v1.snapshot` and `section.v1.action` methods with
// `experimental_discoverable: true`, and the Statusbar plugin finds it on its
// next discovery tick. There is no dependency to declare and no install order
// to respect: the bar polls, matches by topic, and prefers a provider over its
// own built-in reader.
//
// It claims topic `spotify`, which is a BUILT-IN topic. That is deliberate: the
// bar's own Spotify reader reads bb-spotify's credentials and cannot persist a
// rotated refresh token (a second writer would race bb-spotify's refresh flow).
// By claiming the topic this plugin REPLACES that reader, and owns the token.
//
// WHAT IT IS NOT
//
// It does not read another plugin's settings, secrets, or database. The whole
// point of the extraction was to stop depending on bb-spotify: this plugin has
// its own Spotify app credentials, its own OAuth flow, and its own stored
// refresh token. Uninstall bb-spotify and this keeps working.
//
// SETUP (see README)
//
//   1. Create a Spotify developer app; register the redirect URI this plugin
//      prints with `bb statusbar-spotify setup`.
//   2. `bb plugin config statusbar-spotify set clientId <id>` and `clientSecret`.
//   3. `bb statusbar-spotify auth start`, approve, then `... auth finish`.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
} from "@robcopeland/bb-statusbar-section-protocol";
import {
  SNAPSHOT_CACHE_MS,
  TOPIC,
  readSection,
  runAction,
  type SpotifySectionDeps,
} from "./section.js";
import {
  SPOTIFY_SCOPES,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  parseAuthorizationInput,
  parseSpotifyApiError,
  refreshAccessToken,
  type PendingAuthSession,
} from "./spotify.js";

const pendingAuthSchema = z.object({
  state: z.string(),
  createdAt: z.string(),
  redirectUri: z.string(),
  code: z.string().optional(),
  callbackUrl: z.string().optional(),
  error: z.string().optional(),
});

function maskSecret(value: string | undefined): string {
  return value ? "set" : "missing";
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function success(text: string) {
  return { exitCode: 0, stdout: `${text}\n` };
}

function failure(text: string) {
  return { exitCode: 1, stderr: `${text}\n` };
}

/**
 * The one discoverable method pair, plus the `defineRpcContract` wrapper that
 * gives the host a schema to validate against.
 *
 * `section.v1.action` is declared even though the section only advertises
 * transport controls: declaring it is what lets the bar route a click back here
 * instead of guessing what "next" means.
 */
export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "The current Spotify playback, as a statusbar section.",
  },
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
    experimental_description: "Run a Spotify transport control for the statusbar section.",
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clientId: {
      type: "string",
      label: "Spotify client ID",
      default: "",
    },
    clientSecret: {
      type: "string",
      label: "Spotify client secret",
      secret: true,
    },
    refreshToken: {
      type: "string",
      label: "Spotify refresh token",
      secret: true,
    },
    defaultDeviceId: {
      type: "string",
      label: "Default Spotify device ID",
      default: "",
    },
    allowDisruptiveActions: {
      type: "boolean",
      label: "Allow agents to start/resume playback",
      default: false,
    },
  });

  // Access token is memory-only until its stated expiry. The refresh token is
  // the durable credential, and it lives in settings (secret) — never in a
  // plain file, a log line, or an RPC payload.
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;
  let refreshing: Promise<string | null> | null = null;

  /**
   * Spotify's token endpoint answers `{ error: "invalid_grant" }` when a refresh
   * token is revoked, expired, or issued to a different client. That is a
   * re-authorize situation, not a transient failure.
   */
  function isInvalidGrant(error: unknown): boolean {
    return error instanceof Error && error.message.includes("invalid_grant");
  }

  async function getRedirectUri(): Promise<string> {
    const appUrl = bb.server.experimental_appUrl;
    const baseUrl = normalizeBaseUrl(appUrl ?? bb.server.loopbackBaseUrl);
    return `${baseUrl}/api/v1/plugins/${bb.pluginId}/http/oauth/callback`;
  }

  async function getPendingAuth(): Promise<PendingAuthSession | null> {
    const value = await bb.storage.kv.get<PendingAuthSession>("pending-auth");
    if (value == null) return null;
    return pendingAuthSchema.parse(value);
  }

  async function setPendingAuth(session: PendingAuthSession | null): Promise<void> {
    if (session === null) {
      await bb.storage.kv.delete("pending-auth");
      return;
    }
    await bb.storage.kv.set("pending-auth", pendingAuthSchema.parse(session));
  }

  /**
   * The access token, refreshing when needed.
   *
   * Returns null rather than throwing when the plugin is simply not connected:
   * "not connected" is an ordinary state for a status bar to render, not a
   * failure to log. Configuration errors (a missing client id or secret) do
   * throw, because those are a setup mistake the user needs to see.
   */
  async function getAccessToken(): Promise<string | null> {
    if (accessToken !== null && Date.now() < accessTokenExpiresAt) return accessToken;

    // Collapse concurrent refreshes onto one request. The bar polls every 3s
    // and a refresh is a network round trip, so without this an expiry could
    // fan out into several identical token requests.
    if (refreshing === null) {
      refreshing = refreshNow().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function refreshNow(): Promise<string | null> {
    const current = await settings.get();
    const clientId = current.clientId.trim();
    const clientSecret = current.clientSecret;
    const refreshToken = current.refreshToken;
    if (!clientId || !clientSecret || !refreshToken) return null;

    const token = await refreshAccessToken({ clientId, clientSecret, refreshToken })
      .catch((error: unknown) => {
        // An invalid_grant means the stored refresh token is dead (revoked,
        // or the app's secret changed). Treat it as "not connected" rather
        // than an error, so the section does not repeat a raw Spotify error
        // on every poll; the detail names the fix instead.
        if (isInvalidGrant(error)) return null;
        throw error;
      });
    if (token === null) return null;

    // THIS is the behavioural difference from the bar's built-in reader: that
    // one deliberately discards a rotated refresh token because bb-spotify owns
    // it. Here we own it, so persisting rotation is required — not doing so
    // would break the connection as soon as Spotify rotates the token.
    if (token.refreshToken && token.refreshToken !== refreshToken) {
      await settings.experimental_set({ refreshToken: token.refreshToken });
    }

    accessToken = token.accessToken;
    // Refresh a minute early so a slow poll never serves an expired token.
    accessTokenExpiresAt = Date.now() + Math.max(0, token.expiresIn - 60) * 1000;
    return accessToken;
  }

  const deps: SpotifySectionDeps = {
    token: getAccessToken,
    disruptiveActionsAllowed: async () => (await settings.get()).allowDisruptiveActions === true,
    defaultDeviceId: async () => {
      const value = (await settings.get()).defaultDeviceId.trim();
      return value.length > 0 ? value : null;
    },
  };

  // ---------------------------------------------------------------------------
  // Section cache
  //
  // The bar polls `snapshot` every 3 seconds. Caching here means a poll that
  // arrives inside the TTL is a memory read rather than a Spotify round trip,
  // and `invalidate` after an action makes a click feel immediate instead of
  // waiting the TTL out.
  // ---------------------------------------------------------------------------

  let cached: { at: number; value: Awaited<ReturnType<typeof readSection>> } | null = null;
  let inFlight: Promise<Awaited<ReturnType<typeof readSection>>> | null = null;

  async function snapshot() {
    const now = Date.now();
    if (cached !== null && now - cached.at < SNAPSHOT_CACHE_MS) {
      return { generatedAt: new Date(cached.at).toISOString(), section: cached.value };
    }
    // Collapse concurrent polls onto one read. The bar can tick while a slow
    // Spotify call is outstanding, and two identical requests would be waste.
    if (inFlight === null) {
      inFlight = readSection(deps)
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const value = await inFlight;
    return { generatedAt: new Date(cached?.at ?? now).toISOString(), section: value };
  }

  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: () => snapshot(),

      [SECTION_METHOD_ACTION]: async ({ actionId }) => {
        // Deliberately NOT wrapped in a try/catch that softens the message: the
        // user pressed a button this section advertised, so the underlying
        // refusal ("playback is disabled", "nothing is playing") is the honest
        // answer and the bar renders it as a toast.
        const message = await runAction(actionId, deps);
        // Drop the cache so the bar's next read reflects the click.
        cached = null;
        return { message };
      },
    },
    {
      // THE LINE THAT MAKES THIS A PROVIDER. Without it the methods are still
      // callable by id, but the bar cannot find them by asking the host which
      // plugins publish section methods.
      experimental_discoverable: true,
      experimental_description: "A Spotify now-playing section for the Statusbar plugin.",
    },
  );

  // ---------------------------------------------------------------------------
  // OAuth callback
  // ---------------------------------------------------------------------------

  bb.http.route("GET", "/oauth/callback", async (context) => {
    const code = context.req.query("code");
    const state = context.req.query("state");
    const error = context.req.query("error") ?? context.req.query("error_description");
    const redirectUri = await getRedirectUri();
    const pending = await getPendingAuth();

    if (!pending) {
      return new Response(
        "Spotify auth callback received, but there is no pending auth session in BB. You can close this tab.",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (state !== pending.state) {
      await setPendingAuth({
        ...pending,
        error: "State mismatch. Start auth again from `bb statusbar-spotify auth start`.",
      });
      return new Response("Spotify auth state mismatch. Return to BB and run auth again.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    await setPendingAuth({
      state: pending.state,
      createdAt: pending.createdAt,
      redirectUri,
      code: code ?? undefined,
      callbackUrl: context.req.url,
      error: error ?? undefined,
    });

    return new Response(
      "Spotify authorization received. Return to BB and run `bb statusbar-spotify auth finish`.",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });

  // ---------------------------------------------------------------------------
  // CLI
  // ---------------------------------------------------------------------------

  const usage = [
    "Statusbar Spotify section",
    "",
    "  bb statusbar-spotify setup",
    "  bb statusbar-spotify auth <start|status|finish> [redirect-url]",
    "  bb statusbar-spotify status",
    "  bb statusbar-spotify pause | play | next | previous",
  ].join("\n");

  bb.cli.register({
    name: "statusbar-spotify",
    summary: "Spotify section for the Statusbar plugin",
    commands: [
      { name: "setup", summary: "Show setup details and the redirect URI", usage: "bb statusbar-spotify setup" },
      { name: "auth", summary: "Start or complete Spotify OAuth", usage: "bb statusbar-spotify auth <start|status|finish> [redirect-url]" },
      { name: "status", summary: "Show what the section is reading", usage: "bb statusbar-spotify status" },
      { name: "pause", summary: "Pause playback", usage: "bb statusbar-spotify pause" },
      { name: "play", summary: "Resume playback", usage: "bb statusbar-spotify play" },
      { name: "next", summary: "Skip to the next track", usage: "bb statusbar-spotify next" },
      { name: "previous", summary: "Go back to the previous track", usage: "bb statusbar-spotify previous" },
    ],
    async run(argv) {
      const [command, subcommand, ...args] = argv;
      if (!command || command === "help" || command === "--help") return success(usage);

      try {
        if (command === "setup") {
          const current = await settings.get();
          const redirectUri = await getRedirectUri();
          return success(
            [
              "Statusbar Spotify section setup",
              `- Redirect URI: ${redirectUri}`,
              `- Client ID: ${current.clientId.trim() ? "set" : "missing"}`,
              `- Client secret: ${maskSecret(current.clientSecret)}`,
              `- Refresh token: ${maskSecret(current.refreshToken)}`,
              `- Default device ID: ${current.defaultDeviceId.trim() || "not set"}`,
              `- Start/resume playback allowed: ${current.allowDisruptiveActions ? "yes" : "no"}`,
              `- OAuth scopes: ${SPOTIFY_SCOPES.join(", ")}`,
              "",
              "Next:",
              "1. Create your own Spotify developer app.",
              "2. Add the redirect URI above to that app.",
              "3. Set the app's client ID and secret:",
              "     bb plugin config statusbar-spotify set clientId <id>",
              "     bb plugin config statusbar-spotify set clientSecret <secret>",
              "4. Authorize:",
              "     bb statusbar-spotify auth start",
              "     (approve in the browser, then)",
              "     bb statusbar-spotify auth finish",
            ].join("\n"),
          );
        }

        if (command === "auth") {
          switch (subcommand) {
            case "start": {
              const current = await settings.get();
              const clientId = current.clientId.trim();
              if (!clientId) {
                return failure(
                  "Spotify client ID is missing. Run `bb statusbar-spotify setup` for the steps.",
                );
              }
              if (!current.clientSecret) {
                return failure(
                  "Spotify client secret is missing. Run `bb statusbar-spotify setup` for the steps.",
                );
              }
              const redirectUri = await getRedirectUri();
              const state = crypto.randomUUID();
              await setPendingAuth({
                state,
                createdAt: new Date().toISOString(),
                redirectUri,
              });
              const url = buildAuthorizationUrl({
                clientId,
                redirectUri,
                state,
                scopes: SPOTIFY_SCOPES,
              });
              return success(
                [
                  "Open this URL and approve access:",
                  "",
                  url,
                  "",
                  `Then run: bb statusbar-spotify auth finish`,
                ].join("\n"),
              );
            }
            case "status": {
              const pending = await getPendingAuth();
              if (!pending) return success("No pending Spotify auth session.");
              return success(
                [
                  "Pending Spotify auth session:",
                  `- Created: ${pending.createdAt}`,
                  `- Redirect URI: ${pending.redirectUri}`,
                  `- Callback received: ${pending.code ? "yes" : "no"}`,
                  `- Error: ${pending.error ?? "none"}`,
                ].join("\n"),
              );
            }
            case "finish": {
              const current = await settings.get();
              const clientId = current.clientId.trim();
              if (!clientId || !current.clientSecret) {
                return failure("Client ID or secret is missing. Run `bb statusbar-spotify setup`.");
              }
              const pending = await getPendingAuth();
              const manualValue = args.join(" ").trim();
              if (!pending && !manualValue) {
                return failure("No pending auth session. Run `bb statusbar-spotify auth start` first.");
              }
              const parsed = parseAuthorizationInput(
                manualValue || pending?.callbackUrl || pending?.code || "",
              );
              if (pending?.state && parsed.state && parsed.state !== pending.state) {
                return failure("Auth state mismatch. Run `bb statusbar-spotify auth start` again.");
              }
              if (!parsed.code) {
                return failure(
                  "No authorization code found. Run `bb statusbar-spotify auth status` or pass the redirect URL explicitly.",
                );
              }
              const redirectUri = pending?.redirectUri ?? (await getRedirectUri());
              const token = await exchangeAuthorizationCode({
                clientId,
                clientSecret: current.clientSecret,
                redirectUri,
                code: parsed.code,
              });
              await settings.experimental_set({ refreshToken: token.refreshToken });
              await setPendingAuth(null);
              // Drop the cached access token so the next read uses the new grant.
              accessToken = null;
              accessTokenExpiresAt = 0;
              cached = null;
              return success("Spotify connection saved. The status bar section is now live.");
            }
            default:
              return failure(usage);
          }
        }

        if (command === "status") {
          const section = await readSection(deps);
          const lines = [
            `Status: ${section.status}`,
            section.text === null ? null : `Text: ${section.text}`,
            section.detail === null ? null : `Detail: ${section.detail}`,
            section.metrics.length === 0
              ? null
              : `Metrics: ${section.metrics.map((m) => `${m.label || "progress"} ${m.value}`).join(", ")}`,
          ].filter((line): line is string => line !== null);
          return success(lines.join("\n"));
        }

        if (["pause", "play", "next", "previous"].includes(command)) {
          const message = await runAction(command, deps);
          cached = null;
          return success(message);
        }

        return failure(usage);
      } catch (error) {
        return failure(parseSpotifyApiError(error));
      }
    },
  });

  bb.log.info(`ready (statusbar section provider; claims topic "${TOPIC}")`);
}
