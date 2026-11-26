import { defineConfig, devices } from '@playwright/test'

// The suite runs against the production build served by `vite preview`. Pick the port with E2E_PORT.
const port = Number(process.env.E2E_PORT ?? 27812)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure', contextOptions: { reducedMotion: 'reduce' } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Never reuse a server that is already on the port: it could be serving a stale build.
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
