import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataSourceBanner } from '@/components/data-source-banner';

describe('DataSourceBanner', () => {
  it('says loudly when the data is simulated', () => {
    render(<DataSourceBanner dataSource="simulated" venue="simulator" serviceLevel="full" />);
    expect(screen.getByText('SIMULATED MARKET')).toBeInTheDocument();
    expect(screen.getByText(/not an exchange/i)).toBeInTheDocument();
  });

  it('says when the data is a recording', () => {
    render(<DataSourceBanner dataSource="replay" venue="coinbase" serviceLevel="full" />);
    expect(screen.getByText('RECORDED MARKET')).toBeInTheDocument();
  });

  it('renders nothing for healthy live data', () => {
    // The ABSENCE of this banner is itself a claim that the data is live, which
    // is why it renders for every other case.
    const { container } = render(
      <DataSourceBanner dataSource="live" venue="coinbase" serviceLevel="full" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('warns when a live feed is degraded', () => {
    render(<DataSourceBanner dataSource="live" venue="coinbase" serviceLevel="degraded" />);
    expect(screen.getByText('Reduced data quality')).toBeInTheDocument();
  });

  it('says forecasting is paused when the feed is unhealthy', () => {
    render(<DataSourceBanner dataSource="live" venue="coinbase" serviceLevel="stale" />);
    expect(screen.getByText(/forecasting paused/i)).toBeInTheDocument();
    expect(screen.getByText(/will not\s+produce a forecast from data it does not trust/i)).toBeInTheDocument();
  });
});
