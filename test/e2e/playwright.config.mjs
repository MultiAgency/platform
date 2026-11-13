import { defineConfig } from '@playwright/test';
if (process.env.PROTO_E2E_ISOLATED !== '1' || !process.env.PROTO_E2E_ARTIFACTS) throw new Error('Use pnpm test:e2e to isolate credentials, source, build, and artifacts.');
export default defineConfig({
  testDir: import.meta.dirname, respectGitIgnore: false, testMatch: '*.spec.mjs', timeout: 90_000, expect: { timeout: 15_000 },
  workers: 1, retries: 0, fullyParallel: false, forbidOnly: true,
  outputDir: `${process.env.PROTO_E2E_ARTIFACTS}/cases`,
  reporter: [['list'], ['json', { outputFile: `${process.env.PROTO_E2E_ARTIFACTS}/results.json` }]],
  use: { headless: true, launchOptions: { executablePath: process.env.BROWSER_EXECUTABLE } },
});
