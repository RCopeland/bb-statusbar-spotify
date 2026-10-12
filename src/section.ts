// The Spotify status-bar section: reading, and the actions that read advertises.
//
// This is the port of two files from the statusbar plugin's built-ins:
//
//   - `packages/statusbar/src/builtins.ts` → `createSpotifyReader()`, the READ path
//   - `packages/statusbar/src/spotify-controls.ts`, the WRITE path
//
// They stay in one module here because, unlike in the bar, there is no
// fallback reader to keep them honest against: this plugin is the only thing
// answering for topic `spotify`, so the reader and its controls are one unit.
//
// WHAT CHANGED IN THE PORT
//
// The bar's built-in reader borrowed bb-spotify's credentials and deliberately
// refused to persist a rotated refresh token, because a second writer would
// race bb-spotify's own refresh flow. This plugin owns its token outright, so
// rotation IS persisted. That is the single behavioural difference that matters.

import {
  sectionPayloadSchema,
  unavailableSection,
  type SectionPayload,
} from "@robcopeland/bb-statusbar-section-protocol";
import {
  getCurrentPlayback,
  parseSpotifyApiError,
  spotifyErrorText,
  spotifyRequest,
  type SpotifyPlaybackState,
} from "./spotify.js";

/** The topic this plugin claims. `spotify` is a built-in topic: claiming it replaces the bar's reader. */
export const TOPIC = "spotify";

/**
 * Worst-case staleness for the bar noticing a change made outside BB (the user
 * pausing in the Spotify app, a track ending, another device taking over).
 * Short, because those changes are invisible to us until we re-read.
 */
export const SNAPSHOT_CACHE_MS = 3_000;

/** The action ids this section advertises. The bar routes these back to us. */
export type SpotifyAction = "previous" | "play" | "pause" | "next" | "like";

const ACTIONS: readonly SpotifyAction[] = ["previous", "play", "pause", "next", "like"];

export function isSpotifyAction(value: string): value is SpotifyAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/** Credentials and policy this section needs, supplied by the plugin factory. */
export interface SpotifySectionDeps {
  /** Access token, or null when the user has not authorized yet. */
  token: () => Promise<string | null>;
  /** Play/resume is disruptive and gated; the other three transports are not. */
  disruptiveActionsAllowed: () => Promise<boolean>;
  /** Playback is addressed here when set. */
  defaultDeviceId: () => Promise<string | null>;
}

/**
 * Build the current reading.
 *
 * Never throws: every failure becomes an `unavailable` section, because a
 * status bar that goes blank is indistinguishable from a bar that is broken.
 */
export async function readSection(deps: SpotifySectionDeps): Promise<SectionPayload> {
  const unavailable = (
    detail: string,
    status: "idle" | "unavailable" | "error" = "unavailable",
  ): SectionPayload => unavailableSection({ topic: TOPIC, status, detail });

  try {
    const token = await deps.token();
    if (token === null) {
      return unavailable("Spotify not connected. Run `bb statusbar-spotify auth start`.");
    }

    const playback = await getCurrentPlayback(token);
    // 204 = nothing playing on any device. Not an error, and not a failure to
    // reach Spotify: it is the ordinary state when the user stopped the app.
    if (playback === null) {
      return sectionPayloadSchema.parse({
        topic: TOPIC,
        status: "idle",
        presentation: "text",
        text: "♪ nothing playing",
        // The longest and least load-bearing section in the row, so it yields
        // its whole slot first when the window is narrow.
        importance: "secondary",
      });
    }

    return playingSection(playback);
  } catch (error) {
    return unavailable(parseSpotifyApiError(error), "error");
  }
}

function playingSection(playback: SpotifyPlaybackState): SectionPayload {
  const item = playback.item;
  const artists = item?.artists?.map((artist) => String(artist.name)) ?? [];
  const hasTrack = typeof item?.uri === "string" && item.uri.length > 0;
  const isPlaying = Boolean(playback.is_playing);

  const progressMs = typeof playback.progress_ms === "number" ? playback.progress_ms : null;
  const durationMs = typeof item?.duration_ms === "number" ? item.duration_ms : null;

  const text =
    item?.name === undefined
      ? "♪ nothing playing"
      : `${isPlaying ? "♪" : "♪ ❚❚"} ${artists.join(", ")} — ${String(item.name)}`;

  const progressLabel =
    progressMs !== null && durationMs !== null && durationMs > 0
      ? `${Math.round((progressMs / durationMs) * 100)}%`
      : null;

  return sectionPayloadSchema.parse({
    topic: TOPIC,
    status: hasTrack ? "ok" : "idle",
    presentation: "text",
    importance: "secondary",
    metrics:
      progressLabel === null
        ? []
        : [
            {
              label: "",
              value: progressLabel,
              tone: "neutral",
              detail: "Track progress.",
              importance: "secondary",
            },
          ],
    text,
    // Controls travel with the reading. The bar renders buttons only when the
    // provider that owns them is the one answering, which here is always us.
    actions: [
      { id: "previous", label: "Previous track", glyph: "⏮" },
      {
        id: isPlaying ? "pause" : "play",
        label: isPlaying ? "Pause" : "Play",
        glyph: isPlaying ? "❚❚" : "▶",
      },
      { id: "next", label: "Next track", glyph: "⏭" },
      { id: "like", label: "Save to Liked Songs", glyph: "♥", enabled: hasTrack },
    ],
    detail: playback.device?.name ?? null,
  });
}

/**
 * Run one transport action and return the toast message for the bar.
 *
 * Throws on refusal: the user pressed a button this section advertised, so a
 * real error is more honest than a soft message. The caller decides whether the
 * section cache is dropped afterwards.
 */
export async function runAction(
  actionId: string,
  deps: SpotifySectionDeps,
): Promise<string> {
  if (!isSpotifyAction(actionId)) {
    throw new Error(`The Spotify section has no "${actionId}" action.`);
  }
  if (actionId === "like") return likeCurrentTrack(deps);
  return controlTransport(actionId, deps);
}

async function controlTransport(
  action: Exclude<SpotifyAction, "like">,
  deps: SpotifySectionDeps,
): Promise<string> {
  const token = await deps.token();
  if (token === null) {
    throw new Error("Spotify is not connected. Run `bb statusbar-spotify auth start`.");
  }

  // Starting playback is the disruptive case: it changes what the room hears.
  // Pausing, skipping, and going back are not gated, matching the bar.
  if (action === "play" && !(await deps.disruptiveActionsAllowed())) {
    throw new Error(
      'Starting playback is disabled. Enable "Allow agents to start/resume playback" in the Statusbar Spotify plugin settings, or use the Spotify app.',
    );
  }

  const deviceId = await deps.defaultDeviceId();
  const query = deviceId === null ? undefined : { device_id: deviceId };

  const request: Record<typeof action, () => Promise<Response>> = {
    pause: () => spotifyRequest("PUT", "/me/player/pause", { accessToken: token, query }),
    play: () => spotifyRequest("PUT", "/me/player/play", { accessToken: token, query }),
    next: () => spotifyRequest("POST", "/me/player/next", { accessToken: token, query }),
    previous: () => spotifyRequest("POST", "/me/player/previous", { accessToken: token, query }),
  };

  const response = await request[action]();
  // Spotify answers 204 No Content on success for these endpoints.
  if (!response.ok && response.status !== 204) {
    throw new Error(`Spotify refused ${action}: ${await spotifyErrorText(response)}`);
  }

  const label =
    action === "pause" ? "Paused"
    : action === "play" ? "Resumed"
    : action === "next" ? "Skipped to the next track"
    : "Went back to the previous track";
  return deviceId === null ? `${label}.` : `${label} on ${deviceId}.`;
}

/** Saves the loaded track to Liked Songs. */
async function likeCurrentTrack(deps: SpotifySectionDeps): Promise<string> {
  const token = await deps.token();
  if (token === null) {
    throw new Error("Spotify is not connected. Run `bb statusbar-spotify auth start`.");
  }

  const playback = await spotifyRequest("GET", "/me/player", { accessToken: token });
  if (playback.status === 204) {
    throw new Error("Nothing is playing, so there is no track to save.");
  }
  if (!playback.ok) {
    throw new Error(`Spotify refused the request: ${await spotifyErrorText(playback)}`);
  }

  const body = (await playback.json()) as { item?: { uri?: string; name?: string } };
  const uri = body?.item?.uri;
  const name = body?.item?.name ?? "the current track";
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("Nothing is playing, so there is no track to save.");
  }

  // Spotify moved "Save to Liked Songs" to /me/library. The older
  // PUT /me/tracks?uris=... answers 403 Forbidden even with the
  // user-library-modify scope, so it must not be used here.
  const save = await spotifyRequest("PUT", "/me/library", {
    accessToken: token,
    query: { uris: uri },
  });
  if (!save.ok && save.status !== 204 && save.status !== 200) {
    throw new Error(`Spotify refused to save the track: ${await spotifyErrorText(save)}`);
  }

  return `Saved ${name} to Liked Songs.`;
}
