const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  /* Generous: the cart checks retry writes with real gaps (see spec) so a
     ~1-min Shopify blip doesn't page anyone; worst case needs ~2 min. */
  timeout: 150_000,
  retries: 1,
  workers: process.env.MONITOR_SUITE === 'full' ? 1 : 2,
  reporter: [['line'], ['json', { outputFile: 'results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 },
    /* "APGO-HealthCheck" marks this traffic so it can be filtered out of
       server logs / analytics if ever needed. */
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 APGO-HealthCheck',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: process.env.MONITOR_SUITE === 'full'
    ? [{ name: 'full', testMatch: /full-commerce\.spec\.js/ }]
    : [{ name: 'light', testMatch: /lightweight\.spec\.js/ }],
});
