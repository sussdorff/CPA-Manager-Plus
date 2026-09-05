import { describe, expect, it } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { getAuthFileSelectionKey } from '@/features/authFiles/model/credentialStatus';
import { CODEX_SPARK_MODEL_ID } from '@/utils/quota/codexQuota';
import { buildQuotaCredentialIdentity } from '@/utils/quota/credentialScope';
import { resolveAccountQuota, type AccountQuotaStores } from './accountQuotaSummary';

const emptyStores = (): AccountQuotaStores => ({
  antigravityQuota: {},
  claudeQuota: {},
  codexQuota: {},
  kimiQuota: {},
  xaiQuota: {},
});

describe('resolveAccountQuota', () => {
  it('keeps the account summary on Codex Main when Spark is more constrained', () => {
    const file = {
      name: 'codex.json',
      type: 'codex',
      authIndex: 'auth-1',
    } as AuthFileItem;
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 36,
          resetLabel: 'main-reset',
          modelScope: { kind: 'family', key: 'codex_main', complete: true },
        },
        {
          id: 'spark-weekly-0',
          label: 'Spark Weekly',
          usedPercent: 95,
          resetLabel: 'spark-reset',
          modelScope: {
            kind: 'models',
            models: [CODEX_SPARK_MODEL_ID],
            complete: true,
          },
        },
      ],
    };

    const summary = resolveAccountQuota(file, emptyStores(), {
      codexQuotaBySelectionKey: new Map([[getAuthFileSelectionKey(file), quota]]),
    });

    expect(summary).toMatchObject({
      usedPercent: 36,
      remainingPercent: 64,
      resetLabel: 'main-reset',
    });
  });

  it('does not treat a scoped Header observation as fresh account-wide quota evidence', () => {
    const file = {
      name: 'codex.json',
      type: 'codex',
      authIndex: 'auth-1',
    } as AuthFileItem;
    const quota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      observedModelScope: {
        kind: 'models',
        models: [CODEX_SPARK_MODEL_ID],
        complete: true,
      },
      observedTraceId: 'spark-trace',
      activeLimit: 'main',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 36,
          resetLabel: 'main-reset',
          modelScope: { kind: 'family', key: 'codex_main', complete: true },
        },
        {
          id: 'spark-weekly-0',
          label: 'Spark Weekly',
          usedPercent: 0,
          resetLabel: 'spark-reset',
          modelScope: {
            kind: 'models',
            models: [CODEX_SPARK_MODEL_ID],
            complete: true,
          },
        },
      ],
    };

    const summary = resolveAccountQuota(file, emptyStores(), {
      codexQuotaBySelectionKey: new Map([[getAuthFileSelectionKey(file), quota]]),
    });

    expect(summary).toMatchObject({
      source: 'cache',
      fetchedAtMs: 1_000,
      observedAtMs: 2_000,
      observedTraceId: 'spark-trace',
      activeLimit: 'main',
      usedPercent: 36,
      remainingPercent: 64,
    });
    expect(summary.observedQuotaAtMs).toBeUndefined();
  });

  it('uses Antigravity tier metadata when the stored plan is unknown', () => {
    const file = {
      name: 'antigravity.json',
      type: 'antigravity',
      authIndex: 'auth-1',
      planType: 'unknown',
    } as AuthFileItem;
    const stores = emptyStores();
    stores.antigravityQuota[file.name] = {
      ...buildQuotaCredentialIdentity(file),
      status: 'success',
      groups: [],
      subscription: {
        plan: 'unknown',
        tierName: 'Antigravity Future',
        tierId: 'future-tier',
      },
    };

    expect(resolveAccountQuota(file, stores).planType).toBe('Antigravity Future');
  });
});

describe('generic plugin quota in the account summary', () => {
  const NOW_MS = Date.parse('2026-08-26T09:20:00Z');

  const contract = (overrides: Record<string, unknown> = {}) => ({
    schema: 'cliproxy.plugin.quota',
    version: 1,
    provider: 'acme-llm',
    availability: 'available',
    observed_at: '2026-08-26T09:15:00Z',
    ttl_seconds: 900,
    windows: [
      {
        id: 'subscription',
        label: 'Monthly usage',
        kind: 'monthly',
        used_percent: 90,
        window_start: '2026-08-01T00:00:00Z',
        window_end: '2026-09-01T00:00:00Z',
        reset_at: '2026-09-01T00:00:00Z',
        reset_accuracy: 'exact',
      },
    ],
    ...overrides,
  });

  const pluginFile = (payload: unknown, overrides: Partial<AuthFileItem> = {}): AuthFileItem =>
    ({
      name: 'acme-account.json',
      provider: 'acme-llm',
      metadata: { status: 'available', plugin_quota: payload },
      ...overrides,
    }) as AuthFileItem;

  it('summarizes a valid plugin contract', () => {
    const quota = resolveAccountQuota(pluginFile(contract()), emptyStores(), { nowMs: NOW_MS });

    expect(quota).toMatchObject({
      status: 'low',
      usedPercent: 90,
      remainingPercent: 10,
      resetAtMs: Date.parse('2026-09-01T00:00:00Z'),
      resetAccuracy: 'exact',
      source: 'cache',
    });
    expect(quota.observedAtMs).toBe(Date.parse('2026-08-26T09:15:00Z'));
  });

  it.each([
    ['unavailable', contract({ availability: 'unavailable', windows: [] })],
    ['unsupported version', contract({ version: 99 })],
    ['unknown schema', contract({ schema: 'some.other.schema' })],
    ['malformed payload', 'not-an-object'],
    ['malformed windows', contract({ windows: 'not-an-array' })],
    ['window without identity or values', contract({ windows: [{ label: 'Nameless' }] })],
    ['stale observation', contract({ observed_at: '2026-08-25T09:00:00Z', ttl_seconds: 900 })],
    ['missing observation timestamp', contract({ observed_at: undefined })],
    ['invalid observation timestamp', contract({ observed_at: 'not-a-timestamp' })],
    ['materially future observation timestamp', contract({ observed_at: '2026-08-26T09:26:00Z' })],
    ['missing freshness ttl', contract({ ttl_seconds: undefined })],
    ['invalid freshness ttl', contract({ ttl_seconds: 0 })],
  ])('produces a bounded unavailable quota for a %s payload', (_name, payload) => {
    const file = pluginFile(payload);
    const quota = resolveAccountQuota(file, emptyStores(), { nowMs: NOW_MS });

    expect(quota.status).toBe('unknown');
    expect(quota.remainingPercent).toBeNull();
    expect(quota.usedPercent).toBeNull();
    // Quota availability is not credential availability.
    expect(file.disabled).toBeUndefined();
    expect(file.unavailable).toBeUndefined();
  });

  it('never lets a plugin contract override a built-in provider adapter', () => {
    const file = {
      name: 'codex.json',
      type: 'codex',
      authIndex: 'auth-1',
      metadata: { plugin_quota: contract() },
    } as AuthFileItem;
    const codexQuota: CodexQuotaState = {
      status: 'success',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 10, resetLabel: 'codex-reset' }],
    };

    const quota = resolveAccountQuota(file, emptyStores(), {
      nowMs: NOW_MS,
      codexQuotaBySelectionKey: new Map([[getAuthFileSelectionKey(file), codexQuota]]),
    });

    expect(quota.usedPercent).toBe(10);
    expect(quota.resetLabel).toBe('codex-reset');
  });

  it('leaves a credential with no plugin contract on the existing empty summary', () => {
    const file = { name: 'plain.json', provider: 'acme-llm', metadata: {} } as AuthFileItem;

    expect(resolveAccountQuota(file, emptyStores(), { nowMs: NOW_MS })).toMatchObject({
      status: 'unknown',
      source: 'none',
    });
  });
});
