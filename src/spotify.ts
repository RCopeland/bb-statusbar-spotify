// Spotify Web API helpers for the Statusbar Spotify section.
//
// Ported from bb-spotify's `src/spotify.ts`. The only intentional differences:
//
//   - `saveTrackToLibrary` is used by the section's "like" action, so it lives
//     here rather than in a CLI-shaped module.
//   - Everything is scoped to what a status-bar section actually needs:
//     token exchange/refresh, current playback, and the four write calls.
//
// Nothing in this file touches another plugin's credentials or settings. The
// plugin owns its own client id, client secret, and refresh token.

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "user-library-modify",
] as const;

const ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
const API_BASE_URL = "https://api.spotify.com/v1";

const FETCH_TIMEOUT_MS = 20_000;

/** A fetch that cannot hang the bar's read path indefinitely. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type PendingAuthSession = {
  state: string;
  createdAt: string;
  redirectUri: string;
  code?: string;
  callbackUrl?: string;
  error?: string;
};

export type SpotifyTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  tokenType: string;
};

export type SpotifyDevice = {
  id: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
};

export type SpotifyTrack = {
  uri?: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album?: { name: string };
};

export type SpotifyPlaybackState = {
  device?: SpotifyDevice;
  repeat_state?: string;
  shuffle_state?: boolean;
  is_playing?: boolean;
  progress_ms?: number;
  currently_playing_type?: string;
  item?: SpotifyTrack | null;
};

function formUrlEncode(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function toBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

/**
 * Turn a Spotify error body into one human-readable line.
 *
 * Spotify answers with `{ error: { status, message } }` on the Web API and
 * `{ error: "invalid_grant" }` on the token endpoint, so both shapes are read.
 */
async function readSpotifyError(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    try {
      payload = await response.text();
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      const status = (error as { status?: unknown }).status;
      if (typeof message === "string") {
        return typeof status === "number"
          ? `Spotify API error ${status}: ${message}`
          : `Spotify API error: ${message}`;
      }
    }
  }

  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `Spotify request failed with HTTP ${response.status}.`;
}

export function parseSpotifyApiError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown Spotify error.";
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}): string {
  const url = new URL(`${ACCOUNTS_BASE_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Accept either a bare authorization code or the whole callback URL.
 *
 * The manual paste path exists because the callback can fail to reach the
 * server (a different browser, a tunnel, a port mismatch), and the code is
 * still visible in the address bar.
 */
export function parseAuthorizationInput(value: string): { code?: string; state?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    return { code: trimmed };
  }
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<SpotifyTokenResponse> {
  const response = await fetchWithTimeout(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${toBasicAuth(input.clientId, input.clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formUrlEncode({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  if (!json.refresh_token) {
    throw new Error("Spotify did not return a refresh token.");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SpotifyTokenResponse> {
  const response = await fetchWithTimeout(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${toBasicAuth(input.clientId, input.clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formUrlEncode({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

/** One request against the Spotify Web API. Returns the raw response. */
export async function spotifyRequest(
  method: "GET" | "PUT" | "POST",
  path: string,
  options: {
    accessToken: string;
    query?: Record<string, string | undefined>;
  },
): Promise<Response> {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  return fetchWithTimeout(url.toString(), {
    method,
    headers: { authorization: `Bearer ${options.accessToken}` },
  });
}

/** Raw error text for a failed Web API response. */
export async function spotifyErrorText(response: Response): Promise<string> {
  return readSpotifyError(response);
}

/** Current playback, or `null` when nothing is playing on any device (204). */
export async function getCurrentPlayback(
  accessToken: string,
): Promise<SpotifyPlaybackState | null> {
  const response = await fetchWithTimeout(`${API_BASE_URL}/me/player`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  return (await response.json()) as SpotifyPlaybackState;
}
