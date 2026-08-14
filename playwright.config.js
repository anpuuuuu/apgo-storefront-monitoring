const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 1,
  workers: 2,
  reporter: [['line'], ['json', { outputFile: 'results.json' }]],
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 },
    /* "APGO-HealthCheck" marks this traffic so it can be filtered out of
       server logs / analytics if ever needed. */
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 APGO-HealthCheck',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
});
