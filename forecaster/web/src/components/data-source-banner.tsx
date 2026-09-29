'use client';

import { Banner } from '@/components/primitives';
import type { DataSource } from '@/core/types';

/**
 * The most important component in the application.
 *
 * If the numbers on screen came from a simulator or a recording, the reader has
 * to know before they read anything else. This renders above the forecast, in a
 * colour that is hard to skim past, and it is not dismissible.
 *
 * It returns null only for genuinely live data — which means the absence of this
 * banner is itself a claim, and one the engine has to justify.
 */
export function DataSourceBanner({
  dataSource,
  venue,
  serviceLevel,
}: {
  dataSource: DataSource;
  venue: string;
  serviceLevel?: string;
}) {
  if (dataSource === 'live') {
    if (serviceLevel === 'degraded') {
      return (
        <Banner tone="warn" title="Reduced data quality">
          Part of the market feed from {venue} is lagging. Forecasts are running on the
          volatility baseline only, and confidence is capped.
        </Banner>
      );
    }
    if (serviceLevel === 'stale' || serviceLevel === 'down') {
      return (
        <Banner tone="danger" title="Feed unhealthy — forecasting paused">
          The market data feed from {venue} has stopped updating. The system will not
          produce a forecast from data it does not trust.
        </Banner>
      );
    }
    return null;
  }

  const label = dataSource === 'simulated' ? 'SIMULATED MARKET' : 'RECORDED MARKET';
  return (
    <Banner tone="warn" title={label}>
      {dataSource === 'simulated' ? (
        <>
          These prices come from a market simulator, not an exchange. Nothing on this page
          describes a real market, and no accuracy figure here is evidence about real
          trading.
        </>
      ) : (
        <>
          These prices are replayed from a recorded capture, not a live feed. Useful for
          checking the system end to end; not a live result.
        </>
      )}
    </Banner>
  );
}
