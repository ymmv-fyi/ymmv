# ymmv JSON API

```
GET https://ymmv.fyi/api/v1/u/<handle>
```

Public, read-only, no auth. Every published profile is available as JSON.

The API lives at `https://ymmv.fyi` only. A request to `http://` or `www.ymmv.fyi` gets a
redirect to the same path and query there (301 for GET and HEAD, 308 otherwise), so call the
canonical origin directly.

## Example

```sh
curl -i https://ymmv.fyi/api/v1/u/bardisty
```

```json
{
  "schema_version": 1,
  "handle": "bardisty",
  "entries": [
    { "key": "editor", "value": "Zed" },
    { "key": "os", "value": "Windows 11" },
    { "key": "shell", "value": "bash" }
  ],
  "extras": [{ "label": "Keyboard", "value": "HHKB" }],
  "updated_at": "2026-07-01T00:00:00.000Z"
}
```

## Response shape

| Field | Meaning |
|-------|---------|
| `schema_version` | Contract version of this success payload. Bumps only when the Profile wire format changes. Check it before parsing. |
| `handle` | The owner's handle, display-cased (URLs are case-insensitive). |
| `entries` | Curated key/value pairs in canonical order. A SPARSE subset of the curated keys: unset keys are omitted, never null. |
| `extras` | Free-form `{label, value}` lines. No schema, never diffed. |
| `updated_at` | Last publish time, ISO 8601, server-stamped. |

The curated keys, in canonical order: `editor`, `os`, `shell`, `prompt`, `terminal`,
`browser`, `window-manager`, `font`, `theme`, `multiplexer`, `version-manager`,
`dotfiles`, `ai-tool`.

Security note: `handle`, entry values, and extras labels/values are user-controlled and
untrusted. Sanitize before rendering them anywhere. (`key` is server-curated and
`updated_at` is server-generated.)

## Statuses

| Status | When | Body |
|--------|------|------|
| 200 | Live published profile | Profile JSON (above) |
| 301 | Handle was renamed | Empty. `Location` stays under `/api/v1/u/<current>`. Browsers and most HTTP clients follow it automatically; the hop is chiefly observable to curl and server-side clients. |
| 301, 308 | Request on `http://` or `www.ymmv.fyi` | Empty. `Location` is the same path and query on `https://ymmv.fyi`, as an absolute URL. The handle is unchanged; this is not a rename. |
| 404 | Unknown, reserved, or unpublished handle | `{"error":"not_found"}` |
| 500 | Server fault (never masked as a 404) | `{"error":"internal_error"}` |

Every response body, including errors, is `application/json`, so a plain `res.json()`
works on any JSON-bodied response (200, 404, 500). Redirect bodies (301, 308) are empty;
browsers and most HTTP clients follow them automatically and land on one of the JSON-bodied
statuses.

## Caching

Cache-control directives the endpoint declares (what it sends, not a promise of edge
behavior):

| Status | cache-control |
|--------|---------------|
| 200, 301 (rename) | `public, max-age=0, s-maxage=30, stale-while-revalidate=86400` |
| 301, 308 (`http://` or `www.`) | `public, max-age=86400` |
| 404 | `public, max-age=0, s-maxage=10, stale-while-revalidate=60` |
| 500 | `no-store` |

A freshly published handle appears within about 10 seconds; a republish is visible to
its owner immediately (`max-age=0`).

A 200 also carries `ETag: "<updated_at>"`, a validator equal to the body's `updated_at`
(exposed to browser clients via `access-control-expose-headers`). Redirects (301, 308) and
404 responses carry none.

## CORS

Every response this endpoint emits carries `access-control-allow-origin: *`, and OPTIONS
preflights are answered (204), so browser clients work with or without custom request
headers. Responses generated outside the endpoint (WAF pages, platform errors) are
outside that promise.

The `http://` and `www.` redirects also carry `access-control-allow-origin: *`, so a simple
browser GET follows them. A preflighted request can't follow a redirect, so it must go to
`https://ymmv.fyi`.

## Stability

Changes to the Profile shape are breaking for consumers and are signaled by a
`schema_version` bump. Error envelopes, statuses, and headers documented here are the
supported contract.
