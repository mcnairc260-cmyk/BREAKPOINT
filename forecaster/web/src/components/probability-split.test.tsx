import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProbabilitySplit } from '@/components/probability-split';

describe('ProbabilitySplit', () => {
  it('shows both sides at equal prominence', () => {
    // Showing only the leading side, or shrinking the other, would turn a 52/48
    // into something that reads as a call. It is not one.
    render(<ProbabilitySplit pAbove={0.52} pBelow={0.48} />);
    expect(screen.getByText('52.0%')).toBeInTheDocument();
    expect(screen.getByText('48.0%')).toBeInTheDocument();
    expect(screen.getByText('Above')).toBeInTheDocument();
    expect(screen.getByText('Below')).toBeInTheDocument();
  });

  it('describes itself for a screen reader', () => {
    render(<ProbabilitySplit pAbove={0.628} pBelow={0.372} />);
    expect(
      screen.getByRole('img', { name: /62.8% above the target, 37.2% below/ }),
    ).toBeInTheDocument();
  });

  it('marks the coin-flip line so a near-even split reads as one', () => {
    render(<ProbabilitySplit pAbove={0.51} pBelow={0.49} />);
    expect(screen.getByText('coin flip')).toBeInTheDocument();
  });

  it('collapses tiny probabilities rather than implying precision', () => {
    render(<ProbabilitySplit pAbove={0.002} pBelow={0.998} />);
    expect(screen.getByText('<1%')).toBeInTheDocument();
    expect(screen.getByText('>99%')).toBeInTheDocument();
  });
});
