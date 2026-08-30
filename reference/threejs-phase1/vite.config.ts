/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built game works from any sub-path, including a
  // project page or a preview deploy.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200, // three.js alone is ~700 kB minified; a warning here is noise.
  },
  server: {
    host: true, // expose on LAN so a phone on the same Wi-Fi can load it
    port: 5174,
  },
  test: {
    // The physics core is deliberately DOM-free pure logic, so the fast node
    // environment is enough — no jsdom dependency required.
    environment: 'node',
    // Only the unit suite. The browser acceptance specs under e2e/ are
    // Playwright's, and Vitest picking them up would fail on its own runner.
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
