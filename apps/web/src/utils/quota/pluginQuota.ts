/**
 * Provider-neutral plugin quota contract.
 *
 * A CLIProxyAPI plugin publishes normalized quota windows through a single
 * versioned auth-metadata key. This module validates that payload so any
 * plugin-backed credential renders in the Quota tab without a per-provider
 * adapter. Nothing here may branch on a provider name.
 *
 * Plugin metadata is untrusted input: every field is type-checked, bounded, and
 * range-checked, and unknown fields are ignored.
 */

import type { AuthFileItem, QuotaResetAccuracy } from '@/types';
import { parseTimestampMs } from '@/utils/timestamp';

export const PLUGIN_QUOTA_METADATA_KEY = 'plugin_quota';
export const PLUGIN_QUOTA_SCHEMA = 'cliproxy.plugin.quota';

/** Contract versions this consumer implements. Anything else is ignored. */
export const SUPPORTED_PLUGIN_QUOTA_VERSIONS: readonly number[] = [1];

/** Bounds that keep a hostile or broken payload from reaching the renderer. */
const MAX_WINDOWS = 32;
const MAX_TEXT_LENGTH = 128;
const MAX_COUNT = 1e15;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
// Permit a small clock-skew tolerance, but do not let a producer make an
// observation fresh indefinitely by reporting a materially future timestamp.
const MAX_FUTURE_OBSERVATION_MS = 5 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

const PLUGIN_QUOTA_WINDOW_KINDS = [
  'five_hour',
  'daily',
  'weekly',
  'monthly',
  'billing',
  'payg',
  'product',
  'summary',
  'unknown',
] as const;

export type PluginQuotaWindowKind = (typeof PLUGIN_QUOTA_WINDOW_KINDS)[number];

export type PluginQuotaAvailability = 'available' | 'unavailable';

export interface PluginQuotaWindow {
  id: string;
  label: string;
  kind?: PluginQuotaWindowKind;
  unit?: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  usedPercent: number | null;
  unlimited: boolean;
  windowStartMs: number | null;
  windowEndMs: number | null;
  resetAt: string;
  resetAtMs: number | null;
  resetAccuracy: QuotaResetAccuracy;
}

export interface PluginQuotaContract {
  provider: string;
  version: number;
  availability: PluginQuotaAvailability;
  observedAtMs: number | null;
  ttlSeconds: number | null;
  /** True when the observation outlived its freshness budget. */
  stale: boolean;
  /** Empty whenever the contract is unavailable or stale. */
  windows: PluginQuotaWindow[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// Matching control characters is the point here: provider-supplied text is
// untrusted and must be stripped of them before it reaches the renderer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g;

const readBoundedText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  // Control characters are stripped so provider text never reaches the DOM raw.
  return value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_TEXT_LENGTH);
};

const readCount = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_COUNT) return null;
  return value;
};

const readPercent = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
};

const readTimestampMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  // parseTimestampMs signals "unparseable" with NaN, which compares false
  // against every range bound, so finiteness must be checked explicitly.
  const parsed = parseTimestampMs(value);
  if (!Number.isFinite(parsed) || parsed < MIN_TIMESTAMP_MS || parsed > MAX_TIMESTAMP_MS) {
    return null;
  }
  return parsed;
};

const readKind = (value: unknown): PluginQuotaWindowKind | undefined =>
  typeof value === 'string' &&
  (PLUGIN_QUOTA_WINDOW_KINDS as readonly string[]).includes(value) &&
  value !== 'unknown'
    ? (value as PluginQuotaWindowKind)
    : undefined;

/**
 * The contract's accuracy vocabulary is wider than the display vocabulary.
 * `derived` is a provider-computed boundary, which this UI presents as an
 * estimate rather than an exact provider-stated time.
 */
const readResetAccuracy = (value: unknown): QuotaResetAccuracy => {
  if (value === 'exact') return 'exact';
  if (value === 'estimated' || value === 'derived') return 'estimated';
  return 'unknown';
};

/**
 * Utilization is taken from the provider when stated, and otherwise derived
 * from a finite allowance. An unlimited window has no utilization.
 */
const resolveUsedPercent = (
  stated: number | null,
  used: number | null,
  limit: number | null,
  unlimited: boolean
): number | null => {
  if (unlimited) return null;
  if (stated !== null) return stated;
  if (used === null || limit === null || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
};

const parseWindow = (value: unknown): PluginQuotaWindow | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = readBoundedText(record.id);
  if (!id) return null;

  const unlimited = record.unlimited === true;
  const used = readCount(record.used);
  const limit = readCount(record.limit);
  const remaining = readCount(record.remaining);
  const usedPercent = resolveUsedPercent(readPercent(record.used_percent), used, limit, unlimited);

  const windowStartMs = readTimestampMs(record.window_start);
  const windowEndMs = readTimestampMs(record.window_end);
  const resetAtMs = readTimestampMs(record.reset_at);
  // A window with neither utilization nor a boundary carries nothing to show.
  if (usedPercent === null && !unlimited && resetAtMs === null && windowEndMs === null) {
    return null;
  }

  return {
    id,
    label: readBoundedText(record.label) || id,
    kind: readKind(record.kind),
    unit: readBoundedText(record.unit) || undefined,
    used,
    limit,
    remaining,
    usedPercent,
    unlimited,
    windowStartMs,
    windowEndMs,
    resetAt: resetAtMs === null ? '' : readBoundedText(record.reset_at),
    resetAtMs,
    resetAccuracy: resetAtMs === null ? 'unknown' : readResetAccuracy(record.reset_accuracy),
  };
};

const parseWindows = (value: unknown): PluginQuotaWindow[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const windows: PluginQuotaWindow[] = [];
  for (const entry of value.slice(0, MAX_WINDOWS)) {
    const window = parseWindow(entry);
    // Window identity must be unique: the first definition of an id wins.
    if (!window || seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }
  return windows;
};

const readPluginQuotaPayload = (file: AuthFileItem): Record<string, unknown> | null => {
  const metadata = asRecord(file.metadata);
  return metadata ? asRecord(metadata[PLUGIN_QUOTA_METADATA_KEY]) : null;
};

/**
 * Parses the plugin quota contract carried by one auth record.
 *
 * Returns `null` when the credential publishes no contract this consumer
 * understands, so existing providers keep their current behavior. Returns a
 * contract with no windows when the provider published one but reported the
 * quota as unavailable, or when the observation is stale.
 */
export const parsePluginQuotaContract = (
  file: AuthFileItem,
  nowMs: number = Date.now()
): PluginQuotaContract | null => {
  const payload = readPluginQuotaPayload(file);
  if (!payload) return null;
  if (payload.schema !== PLUGIN_QUOTA_SCHEMA) return null;
  const version = payload.version;
  if (typeof version !== 'number' || !SUPPORTED_PLUGIN_QUOTA_VERSIONS.includes(version)) {
    return null;
  }

  const observedAtMs = readTimestampMs(payload.observed_at);
  const ttlSecondsRaw = readCount(payload.ttl_seconds);
  const ttlSeconds =
    ttlSecondsRaw !== null && ttlSecondsRaw > 0 ? Math.min(ttlSecondsRaw, MAX_TTL_SECONDS) : null;
  const freshnessValid =
    observedAtMs !== null &&
    ttlSeconds !== null &&
    observedAtMs <= nowMs + MAX_FUTURE_OBSERVATION_MS;
  const stale = !freshnessValid || nowMs > (observedAtMs ?? nowMs) + (ttlSeconds ?? 0) * 1000;
  const available = payload.availability === 'available' && !stale;

  return {
    provider: readBoundedText(payload.provider),
    version,
    availability: available ? 'available' : 'unavailable',
    observedAtMs,
    ttlSeconds,
    stale,
    windows: available ? parseWindows(payload.windows) : [],
  };
};
