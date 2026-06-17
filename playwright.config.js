const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir:    './tests',
  timeout:     60_000,
  expect:    { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries:    process.env.CI ? 1 : 0,
  workers:    1,
  reporter:   process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'],   ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results/',
  // Two projects so the fast Manager-UI suite stays separate from the heavy artifact test:
  //  - "ui": the default suite (everything except the AppImage build/launch test).
  //  - "appimage": the integration test that builds + launches a real AppImage. It is excluded
  //    from "ui" and runs via `npm run test:appimage` with no retries (a retried 3-min build would
  //    blow any reasonable CI budget) and its own long per-test timeout (set in the spec).
  projects: [
    { name: 'ui',       testIgnore: '**/appimage-*.spec.js' },
    { name: 'appimage', testMatch: '**/appimage-*.spec.js', retries: 0 },
  ],
})
