import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:17070', headless: true },
  webServer: {
    command: 'node test/e2e-server.mjs',
    url: 'http://127.0.0.1:17070/health',
    reuseExistingServer: false,
  },
});
