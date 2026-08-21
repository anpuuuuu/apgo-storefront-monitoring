const { defineConfig } = require('@playwright/test');
const fullSuite = process.env.MONITOR_SUITE === 'full';

module.exports = defineConfig({
  testDir: './tests',
  /* Generous: the cart checks retry writes with real gaps (see spec) so a
     ~1-min Shopify blip doesn't page anyone; worst case needs ~2 min. */
  timeout: fullSuite ? 420_000 : 300_000,
  // Retrying a complete commerce journey repeats real Shopify writes and can
  // itself trigger 429s. Individual requests retry with backoff instead.
  retries: 0,
  // Shopify applies storefront/cart throttles per client. Serial contexts keep
  // checks isolated without manufacturing traffic spikes.
  workers: 1,
  reporter: [['line'], ['json', { outputFile: 'results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 },
    /* Keep the HTTP UA browser-shaped: Shopify throttles HeadlessChrome more
       aggressively. The fixture appends APGO-HealthCheck only inside the page,
       so the request still receives the normal customer storefront document. */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    serviceWorkers: 'block',
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
