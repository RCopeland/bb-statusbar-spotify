# bb-statusbar-spotify

A **Spotify now-playing section** for the [Statusbar](https://github.com/RCopeland/bb-plugin-statusbar)
BB plugin, with transport controls.

It is a **standalone** plugin. It does not read, import, or depend on
`bb-spotify` in any way: it owns its own Spotify app credentials, its own OAuth
flow, and its own stored refresh token.

```
♪ Artist — Track        ⏮  ❚❚  ⏭  ♥
♪ ❚❚ Artist — Track     ⏮  ▶   ⏭  ♥     (paused)
♪ nothing playing
```

## How it works

BB has no plugin dependency mechanism — no `dependsOn`, no load ordering. So this
plugin does not "require" the statusbar. Instead it implements the published
[`@robcopeland/bb-statusbar-section-protocol`](https://www.npmjs.com/package/@robcopeland/bb-statusbar-section-protocol)
and advertises itself:

- it publishes `section.v1.snapshot` and `section.v1.action` with
  `experimental_discoverable: true`;
- the bar polls the host every 10s for plugins that publish section methods,
  matches them by topic, and **prefers a discovered provider over its own
  built-in reader**;
- it claims topic `spotify`, so it **replaces** the bar's built-in Spotify
  reader.

Nothing installs in any particular order. No bar installed means nothing ever
calls this code and it costs nothing. Disable this plugin and the topic
gracefully returns to the bar's built-in reader.

### Why it replaces the built-in

The bar's built-in Spotify reader borrows **bb-spotify's** credentials and
deliberately discards a rotated refresh token, because a second writer would
race bb-spotify's own refresh flow. That made the bar's Spotify section
dependent on bb-spotify being installed and authorized.

By claiming the topic, this plugin takes over and **persists rotation**, which
it can do safely because it is the only writer.

## Requirements

- BB `>= 0.44`
- The Statusbar plugin installed and running (otherwise the section is never
  read — the plugin is still harmless)
- Your own Spotify developer app
- **Spotify Premium** for the playback-control endpoints (`pause`, `play`,
  `next`, `previous`)

It does **not** ship a shared Spotify app. Each user creates their own.

## Install

```sh
bb plugin install . --yes
```

## Setup

### 1. Create a Spotify developer app

At <https://developer.spotify.com/dashboard>, create an app. Print the exact
redirect URI to register:

```sh
bb statusbar-spotify setup
```

It prints something like:

```
http://127.0.0.1:38886/api/v1/plugins/statusbar-spotify/http/oauth/callback
```

Add that string **verbatim** to your Spotify app's Redirect URIs.

### 2. Store your app's credentials

```sh
bb plugin config statusbar-spotify set clientId <your-client-id>
bb plugin config statusbar-spotify set clientSecret <your-client-secret>
```

Both are also editable in the BB plugin settings UI. The client secret and the
refresh token are declared `secret: true`, so BB stores them as plugin secrets
and never returns them over RPC.

### 3. Authorize

```sh
bb statusbar-spotify auth start     # prints an authorization URL
```

Approve in the browser. The callback lands on this plugin's own route and records
the code. Then:

```sh
bb statusbar-spotify auth finish
```

If the callback does not reach BB (a different browser, a tunnel, a port
mismatch), the code is still in the address bar — pass the whole redirect URL:

```sh
bb statusbar-spotify auth finish 'http://127.0.0.1:.../oauth/callback?code=...&state=...'
```

The section is live on the bar's next read.

## Controls

The section advertises four controls and routes clicks back to this plugin:

| Control | Action id | Gated? |
| --- | --- | --- |
| ⏮ Previous track | `previous` | no |
| ❚❚ / ▶ Pause / Play | `pause` / `play` | **`play` is gated** |
| ⏭ Next track | `next` | no |
| ♥ Save to Liked Songs | `like` | no |

**Starting playback is gated** behind this plugin's own
`allowDisruptiveActions` setting, off by default:

```sh
bb plugin config statusbar-spotify set allowDisruptiveActions true
```

When off, a click surfaces a toast naming the setting rather than failing
silently. Pausing, skipping, and going back are never gated — they only reduce
what is already happening.

Playback is addressed to `defaultDeviceId` when one is set:

```sh
bb plugin config statusbar-spotify set defaultDeviceId <spotify-device-id>
```

## CLI

```
bb statusbar-spotify setup
bb statusbar-spotify auth <start|status|finish> [redirect-url]
bb statusbar-spotify status
bb statusbar-spotify pause | play | next | previous
```

## Credentials and privacy

| Value | Where it lives |
| --- | --- |
| `clientId` (not a secret) | plugin settings |
| `clientSecret` | plugin settings, `secret: true` |
| `refreshToken` | plugin settings, `secret: true`, updated on rotation |
| access token | server memory only, until its stated expiry minus 60s |

- No credential is ever logged, written to a plain file, or returned in a
  section payload.
- The access token never leaves the server process.
- This plugin reads **nothing** from `bb-spotify` — not its settings, not its
  secrets, not its database.

Like every BB plugin, it runs as full-trust code inside the BB server.

## Development

```sh
npm install
npm run typecheck
npm run build
bb plugin install . --yes
bb plugin reload statusbar-spotify
```

Verify it is discovered:

```sh
bb plugin rpc list | grep statusbar-spotify
bb plugin rpc call statusbar providers --json     # should list topic "spotify"
bb plugin rpc call statusbar-spotify section.v1.snapshot --json
```

`react`, `hono`, and `better-sqlite3` are devDependencies only. The SDK's
bundled type declarations import them, so they must be resolvable for
`tsc --noEmit` to pass in a standalone checkout. They are not runtime
dependencies and are not bundled.

## Known constraints

- **Providers cannot be authenticated.** On BB 0.44 / SDK 0.5.29 the RPC handler
  context is `undefined`; caller identity (`experimental_caller`) needs SDK
  ≥ 0.6.3. Any plugin could in principle claim the `spotify` topic. This is
  accepted because a section is not a privilege — anyone who can register a
  plugin is already full-trust.
- **Discovery is a 10s poll**, so installing or removing this plugin takes up to
  10 seconds to be reflected on the bar.
- **`bb.sdk` does not exist during the plugin factory**, so this plugin never
  checks whether a bar is present. It just answers correctly when called.

## License

MIT
