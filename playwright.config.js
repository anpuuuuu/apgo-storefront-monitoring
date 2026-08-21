const { defineConfig } = require('@playwright/test');
const fullSuite = process.env.MONITOR_SUITE === 'full';

module.exports = defineConfig({
  testDir: './tests',
  /* Generous: the cart checks retry writes with real gaps (see spec) so a
     ~1-min Shopify blip doesn't page anyone; worst case needs ~2 min. */
  timeout: fullSuite ? 420_000 : 180_000,
  // Retrying a complete MY/SG commerce journey repeats many real Shopify
  // writes and can itself trigger 429s. Light checks retain one retry; full
  // checks use resilient steps and fail once with complete diagnostics.
  retries: fullSuite ? 0 : 1,
  workers: fullSuite ? 1 : 2,
  reporter: [['line'], ['json', { outputFile: 'results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 },
    /* Keep Playwright's real browser UA. Shopify maintains separate document
       caches for browser versions and a hard-coded UA can receive stale
       theme HTML. The fixture marks synthetic traffic before page scripts run. */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Traces already include screenshots and network timing. Full-page video
    // made a single failed commerce run exceed 500 MB without adding useful
    // evidence, so keep diagnostics focused and inexpensive.
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: fullSuite
    ? [{ name: 'full', testMatch: /full-commerce\.spec\.js/ }]
    : [{ name: 'light', testMatch: /lightweight\.spec\.js/ }],
});
