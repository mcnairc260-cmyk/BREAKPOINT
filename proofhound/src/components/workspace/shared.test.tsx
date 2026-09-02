import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceLink } from '@/components/workspace/shared';
import { makeSource } from '@/core/test-support';

/**
 * Source URLs come from search providers, which sit outside the trust boundary.
 */
describe('SourceLink', () => {
  it('links an ordinary http(s) source', () => {
    render(<SourceLink source={makeSource({ id: 'a', url: 'https://example.com/story' })} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/story');
  });

  it('refuses to link a non-http scheme', () => {
    // Regression: React blocks `javascript:` but renders `data:` verbatim, so a
    // hostile provider could have supplied a link to attacker-controlled markup.
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'not a url at all',
    ]) {
      const { unmount } = render(<SourceLink source={makeSource({ id: 'x', url })} />);
      expect(screen.queryByRole('link')).toBeNull();
      // The address is still shown, so nothing is hidden from the reader.
      expect(screen.getByText(url)).toBeInTheDocument();
      unmount();
    }
  });

  it('shows a demonstration URL as text rather than a dead link', () => {
    render(<SourceLink source={makeSource({ id: 'd', url: 'https://demo.proofhound.invalid/x' })} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing when a source has no URL', () => {
    const { container } = render(<SourceLink source={makeSource({ id: 'n', url: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
