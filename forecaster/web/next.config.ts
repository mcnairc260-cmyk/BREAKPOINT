import type { NextConfig } from 'next';

/**
 * The API runs as a separate Python process, so the browser needs a way to
 * reach it that does not depend on which port the front end happens to be on.
 *
 * In development, requests to `/api/*` are rewritten to the engine. In
 * production the Next output is exported as static files and served by the
 * engine itself, so the same relative paths resolve without any rewriting —
 * one origin, no CORS, nothing to configure.
 */
const engine = process.env.FORECASTER_API ?? 'http://127.0.0.1:8099';

const config: NextConfig = {
  output: process.env.NEXT_EXPORT === '1' ? 'export' : undefined,
  reactStrictMode: true,
  async rewrites() {
    if (process.env.NEXT_EXPORT === '1') return [];
    return [{ source: '/api/:path*', destination: `${engine}/api/:path*` }];
  },
};

export default config;
