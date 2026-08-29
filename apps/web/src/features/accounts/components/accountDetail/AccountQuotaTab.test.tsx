import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AccountDetailViewModel } from '@/features/accounts/model/accountDetailViewModel';
import { AccountQuotaTab } from './AccountQuotaTab';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
      i18n: { language: 'en-US' },
    }),
  };
});

const detailView = {
  identity: { provider: 'example-plugin' },
  quota: {
    windows: [
      {
        key: 'subscription',
        label: 'Total',
        remainingPercent: 85,
        usedPercent: 15,
        windowMode: 'fixed',
        resetLabel: 'in 20d',
        resetAtMs: Date.parse('2026-09-19T19:00:00Z'),
        currentUsage: {
          fromMs: 1,
          toMs: 2,
          matched: true,
          totalRequests: 10,
          successCalls: 10,
          failureCalls: 0,
          totalTokens: 100,
          totalCost: 1,
          successRate: 100,
          lastSeenMs: 2,
          syncStatus: 'ready',
          scopeMatchStatus: 'complete',
          unmatchedRequests: 0,
        },
        previousUsage: {
          fromMs: 0,
          toMs: 1,
          matched: true,
          totalRequests: 8,
          successCalls: 8,
          failureCalls: 0,
          totalTokens: 80,
          totalCost: 0.8,
          successRate: 100,
          lastSeenMs: 1,
          syncStatus: 'ready',
          scopeMatchStatus: 'complete',
          unmatchedRequests: 0,
        },
        forecast: { requests: 12, tokens: 120, cost: 1.2, basis: 'quota' },
        observationSource: 'api_query',
        observedAtMs: Date.parse('2026-08-28T11:55:00Z'),
        boundaryAccuracy: 'exact',
      },
    ],
    cooldown: null,
    resetCreditsAvailableCount: null,
    resetCreditExpiries: [],
    plugin: {
      availability: 'available',
      stale: false,
      observedAtMs: Date.parse('2026-08-28T11:55:00Z'),
      currency: 'JPY',
      minorUnit: 0,
      windows: [],
      spend: {
        meteredMinorUnits: 98655,
        todayMinorUnits: 458,
        periodMinorUnits: 124717,
        latestTokens: 1901,
        periodTokens: 245002,
      },
      daily: [
        { date: '2026-08-27', costMinorUnits: 19800, tokens: 12600 },
        { date: '2026-08-28', costMinorUnits: 458, tokens: 1901 },
      ],
      topModel: 'example-model',
      provenance: ['usage_summary', 'usage_events'],
    },
  },
  history: {
    totalRequests: 12,
    totalTokens: 3456,
    totalCost: 4.5,
    successRate: 99.5,
    firstSeenMs: Date.parse('2026-08-27T00:00:00Z'),
    lastSeenMs: Date.parse('2026-08-27T01:00:00Z'),
  },
} as unknown as AccountDetailViewModel;

const render = async (view: AccountDetailViewModel = detailView) => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AccountQuotaTab
        detailView={view}
        windowUsageError=""
        historyAvailable={false}
        historyRefreshing={false}
        onRefreshHistory={() => undefined}
        onResetQuota={() => undefined}
        resetQuotaDisabled
      />
    );
  });
  return renderer!;
};

const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(text).join('')
    : typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : value && typeof value === 'object' && 'children' in value
        ? text((value as { children?: unknown }).children)
        : '';

const markerOrder = (value: unknown, markers: string[]): number[] => {
  const serialized = JSON.stringify(value);
  return markers.map((marker) => serialized.indexOf(marker));
};

describe('AccountQuotaTab plugin quota details', () => {
  it('adds generic plugin usage without replacing native usage metrics', async () => {
    const renderer = await render();
    const renderedText = text(renderer.toJSON());
    const pluginPanelText = text(
      renderer.root.findByProps({ 'data-account-plugin-quota': 'true' }).children
    );

    expect(renderedText).toContain('accounts.detail_total_requests');
    expect(renderedText).toContain('accounts.detail_total_tokens');
    expect(renderedText).toContain('accounts.detail_total_cost');
    expect(renderedText).toContain('accounts.detail_success_rate');
    expect(renderedText).toContain('Metered spend');
    expect(renderedText).toContain('JPY');
    expect(pluginPanelText).not.toContain('$');
    expect(pluginPanelText).not.toContain('Cursor');
    expect(renderedText.indexOf('accounts.detail_success_rate')).toBeLessThan(
      renderedText.indexOf('Metered spend')
    );
    expect(renderer.root.findAllByProps({ 'data-account-plugin-quota': 'true' })).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ 'data-account-plugin-quota-provenance': 'true' })
    ).toHaveLength(1);
  });

  it('renders compact remaining bars before the daily histogram and totals', async () => {
    const renderer = await render();
    const [bars, chart, totals] = markerOrder(renderer.toJSON(), [
      'data-quota-bar-list',
      'data-account-quota-daily-chart',
      'data-account-quota-usage-summary',
    ]);

    expect(renderer.root.findAllByProps({ 'data-quota-card-variant': 'compact' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-quota-standard-comparison': 'true' })).toHaveLength(
      0
    );
    expect(renderer.root.findAllByProps({ 'data-quota-usage-forecast': 'true' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-quota-source-warnings': 'true' })).toHaveLength(0);
    expect(text(renderer.toJSON())).not.toContain('accounts.detail_previous_usage');
    expect(text(renderer.toJSON())).not.toContain('accounts.detail_current_forecast');
    expect(bars).toBeGreaterThan(-1);
    expect(chart).toBeGreaterThan(bars);
    expect(totals).toBeGreaterThan(chart);
  });

  it('renders the daily histogram as compact bars with hover details', async () => {
    const renderer = await render();
    const chart = renderer.root.findByProps({ 'data-account-quota-daily-chart': 'true' });
    const bars = renderer.root.findAllByProps({ 'data-account-quota-daily-bar': 'true' });

    expect(chart.type).toBe('ul');
    expect(chart.props.role).toBeUndefined();
    expect(chart.props['aria-label']).toBeUndefined();
    expect(bars).toHaveLength(2);
    expect(bars[1].props.title).toContain('2026-08-28');
    expect(bars[1].props.title).toContain('458 JPY');
    expect(bars[1].props.title).toContain('1,901 accounts.detail_usage_tokens');
    expect(bars[1].findAllByType('strong')).toHaveLength(0);
    expect(text(renderer.toJSON())).not.toContain('Daily plugin usage');
    expect(text(renderer.toJSON())).not.toContain('1,901 tokens');
  });

  it('renders daily raw minor units when spend and money metadata are absent', async () => {
    const dailyOnlyView = {
      ...detailView,
      quota: {
        ...detailView.quota,
        plugin: {
          ...detailView.quota.plugin,
          currency: null,
          minorUnit: null,
          spend: null,
          daily: [{ date: '2026-08-28', costMinorUnits: 458, tokens: 1901 }],
        },
      },
    } as AccountDetailViewModel;
    const renderer = await render(dailyOnlyView);

    expect(text(renderer.toJSON())).toContain('458 minor units');
    expect(renderer.root.findAllByProps({ 'data-account-quota-daily-bar': 'true' })).toHaveLength(
      1
    );
  });

  it('renders unavailable and stale state while retaining native metrics', async () => {
    const staleView = {
      ...detailView,
      quota: {
        ...detailView.quota,
        plugin: {
          ...detailView.quota.plugin,
          spend: null,
          daily: [],
          topModel: null,
          provenance: [],
          availability: 'unavailable',
          stale: true,
        },
      },
    } as AccountDetailViewModel;
    const renderer = await render(staleView);
    const renderedText = text(renderer.toJSON());

    expect(renderedText).toContain('accounts.detail_quota_snapshot_stale');
    expect(renderedText).toContain('accounts.detail_total_requests');
    const state = renderer.root.findByProps({ 'data-account-plugin-quota-state': 'true' });
    expect(state.props.role).toBeUndefined();
  });
});
