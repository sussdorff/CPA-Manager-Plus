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

Rendering plugin quota therefore requires a CLIProxyAPI build that projects the
plugin quota onto the list entry as `metadata.plugin_quota`. The host does not
pass the payload through; it rebuilds it from an allowlist:

- `plugin_quota` is the only metadata key projected. Every other key, known or
  unknown, stays omitted, so credential material that also lives in auth
  metadata - `access_token`, `refresh_token`, raw `id_token` strings, cookies,
  profile directory paths, `StorageJSON`, raw upstream bodies - cannot reach
  CPAMP through this field.
- The payload is projected only when it declares `schema:
  cliproxy.plugin.quota` and a `version` the host implements.
- **Within the contract, the host emits a version-1 field allowlist and drops
  every unknown field.** Auth metadata is plugin-controlled all the way down, so
  a well-formed envelope is no evidence that what it wraps is safe: a value
  nested inside an otherwise valid contract is dropped exactly like one placed
  beside it.
- The allowlisted fields are themselves bounded - at most 32 windows, and text
  values dropped rather than truncated past 256 bytes.

The host allowlist is the version-1 envelope and window field set tabulated
below, so a producer that follows this reference survives the projection intact.
CPAMP's own parser is unchanged by this and still ignores fields it does not
know; the host projection simply means an unknown field rarely reaches it.

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

A Cursor plugin observation can fill `windows` with more than one entry. The
consumer still treats them as generic rows: Total, Cursor, Third Party, and
Grok Bot are just labels and kinds, not a provider branch.

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
| `spend`        | no       | Optional cost summary. Money fields are USD cents. Unknown keys are ignored.         |
| `daily`        | no       | Optional UTC day rows (`date`, `cost_cents`, `tokens`) for a cost histogram.         |

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
- **An added optional field is not visible until the host learns it.**
  CLIProxyAPI projects a fixed version-1 allowlist and drops fields outside it,
  so a new optional field never reaches CPAMP until a CLIProxyAPI release adds
  it to that allowlist. Ship the host first and the producer second, or the
  field is silently absent rather than ignored.
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
