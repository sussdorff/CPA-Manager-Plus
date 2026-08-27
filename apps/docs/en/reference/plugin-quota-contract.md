---
title: Plugin Quota Contract
description: The versioned, provider-neutral quota-window payload a CLIProxyAPI plugin publishes through auth metadata so CPAMP can display its quota without a provider-specific adapter.
---

# Plugin Quota Contract

CPAMP ships built-in quota collectors for Codex, Claude, Antigravity, Kimi, and
xAI. A CLIProxyAPI **plugin** provider cannot use those collectors, because
CPAMP has no way to know how the plugin's upstream reports consumption.

The plugin quota contract closes that gap. A plugin publishes normalized quota
windows through its CLIProxyAPI auth metadata, and CPAMP renders them in the
Accounts Quota tab. There is no provider-specific code on the CPAMP side: the
same parser and renderer serve every plugin that emits the contract.

## Where the payload lives

A plugin writes the contract into its `AuthData.Metadata` map under a single
key, and CPAMP reads it from each entry of

```
GET /v0/management/auth-files   ->   file.metadata.plugin_quota
```

### This requires a CLIProxyAPI build that exposes the key

**Stock CLIProxyAPI does not put auth metadata on that list endpoint.**
`buildAuthFileEntryLocked` in `internal/api/handlers/management/auth_files.go`
lifts only `priority` and `note` out of `AuthData.Metadata` and emits no
`metadata` object, as of `v7.2.141` and `v7.2.143`. A plugin can publish a
perfectly valid contract and CPAMP will still see nothing.

Rendering plugin quota therefore requires a CLIProxyAPI build that copies the
allowlisted plugin quota onto the list entry as `metadata.plugin_quota`. The
copy is narrow by construction:

- `plugin_quota` is the only metadata key copied. Every other key, known or
  unknown, stays omitted, so credential material that also lives in auth
  metadata - `access_token`, `refresh_token`, raw `id_token` strings, cookies,
  profile directory paths, `StorageJSON`, raw upstream bodies - cannot reach
  CPAMP through this field.
- The payload is copied only when it declares `schema: cliproxy.plugin.quota`
  and a numeric `version`.
- Within a well-formed contract, fields are copied verbatim, so a producer can
  add optional fields without the proxy needing to learn them first.

Against a CLIProxyAPI build without that change, `file.metadata` is absent and
CPAMP degrades to the **no contract** state described below: the account keeps
its existing empty quota summary and stays fully usable.

Everything else in `metadata` keeps its existing meaning. A credential that
publishes no `plugin_quota` key behaves exactly as it does today.

## Payload

```json
{
  "schema": "cliproxy.plugin.quota",
  "version": 1,
  "provider": "cursor-acp",
  "availability": "available",
  "observed_at": "2026-08-26T09:15:00Z",
  "ttl_seconds": 900,
  "windows": [
    {
      "id": "subscription",
      "label": "Monthly usage",
      "kind": "monthly",
      "unit": "requests",
      "used": 125,
      "limit": 500,
      "remaining": 375,
      "used_percent": 25,
      "unlimited": false,
      "window_start": "2026-08-01T00:00:00Z",
      "window_end": "2026-09-01T00:00:00Z",
      "reset_at": "2026-09-01T00:00:00Z",
      "reset_accuracy": "exact"
    }
  ]
}
```

### Envelope

| Field          | Required | Rule                                                                                 |
| -------------- | -------- | ------------------------------------------------------------------------------------ |
| `schema`       | yes      | Must be `cliproxy.plugin.quota`. CPAMP ignores the payload otherwise.                |
| `version`      | yes      | Integer. CPAMP implements version `1` and ignores any version it does not know.      |
| `provider`     | no       | Publishing provider identifier. Informational only; CPAMP never branches on it.      |
| `availability` | yes      | `available` or `unavailable`. Any other value is treated as `unavailable`.           |
| `observed_at`  | no       | RFC3339 UTC. When the provider took the observation.                                 |
| `ttl_seconds`  | no       | Positive integer, capped at 7 days. How long the observation stays displayable.      |
| `windows`      | yes      | Array, at most 32 entries. Must be empty whenever `availability` is not `available`. |

### Window

| Field                        | Required | Rule                                                                                                             |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                         | yes      | Stable identity, unique within the payload. The first definition of an id wins.                                  |
| `label`                      | no       | Display label. Bounded to 128 characters, control characters stripped. Defaults to `id`.                         |
| `kind`                       | no       | One of `five_hour`, `daily`, `weekly`, `monthly`, `billing`, `payg`, `product`, `summary`. Inferred when absent. |
| `unit`                       | no       | Unit for `used` / `limit` / `remaining`.                                                                         |
| `used`, `limit`, `remaining` | no       | Non-negative finite numbers.                                                                                     |
| `used_percent`               | no       | `0`-`100`. Clamped. Derived from `used` / `limit` when absent.                                                   |
| `unlimited`                  | no       | Boolean. An unlimited window reports no utilization.                                                             |
| `window_start`, `window_end` | no       | RFC3339 UTC. Used to derive the window duration.                                                                 |
| `reset_at`                   | no       | RFC3339 UTC boundary shown as the reset time.                                                                    |
| `reset_accuracy`             | no       | `exact`, `derived`, `estimated`, or `unknown`. CPAMP presents `derived` as `estimated`.                          |

A window that carries neither a utilization value nor a usable boundary is
dropped: CPAMP will not invent a reset time it was not given.

## Availability, staleness, and credential health

Three states are deliberately distinct:

- **No contract.** The credential publishes no `plugin_quota` key, or one CPAMP
  cannot parse. The account keeps its existing empty quota summary.
- **Unavailable contract.** The plugin published a contract but could not
  observe quota. CPAMP shows a bounded unavailable quota state.
- **Stale contract.** `observed_at + ttl_seconds` is in the past. CPAMP treats
  the observation as unavailable rather than presenting a value the provider no
  longer stands behind.

**Quota availability is never credential availability.** A missing, stale,
malformed, or unavailable quota payload cannot disable a credential or remove it
from CLIProxyAPI's rotation. Credential health comes only from the credential's
own status.

## Precedence

Built-in provider collectors stay authoritative. The plugin contract is
evaluated only after every built-in adapter has declined to produce windows, so
a plugin payload can never override richer Codex, Claude, Antigravity, Kimi, or
xAI data.

Plugin windows are displayed but not written to the quota snapshot history
service, which accepts only the five built-in providers.

## Security

Plugin metadata is untrusted input. CPAMP consumes only the fields listed above
and ignores everything else. Every string is length-bounded and stripped of
control characters, every number is range-checked, every timestamp must parse
and fall inside a sane range, and the window list is capped.

A producer must never place access tokens, cookies, profile directory paths, or
raw upstream response bodies into auth metadata.

## Evolving the contract compatibly

- **Adding an optional field** does not change `version`. CPAMP ignores unknown
  fields, so older consumers keep working.
- **Changing the meaning of an existing field, or adding a required field,**
  requires incrementing `version`. Consumers ignore versions they do not
  implement, so an unrecognized version degrades to "no contract" rather than to
  a wrong number.
- **Removing a field** is a version increment.
- A producer publishes exactly one version at a time.

To add support for a new version in CPAMP, extend
`SUPPORTED_PLUGIN_QUOTA_VERSIONS` in `apps/web/src/utils/quota/pluginQuota.ts`
and branch inside the parser. Keep the previous version's parsing intact until
every deployed producer has moved on.

## Reference implementation

`cliproxy-cursor-acp` publishes this contract from its account-scoped Cursor
subscription observation. Its golden payload is checked into CPAMP at
`apps/web/src/utils/quota/pluginQuotaCursorV1.json` and asserted by
`apps/web/src/services/api/authFiles.test.ts`, so a producer change that drifts
from the contract fails CPAMP's test suite as well as its own.
