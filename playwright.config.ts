import {defineConfig} from '@playwright/test'

export default defineConfig({
  expect: {timeout: 10_000},
  forbidOnly: Boolean(process.env.CI),
  // The MCP tool suites drive stateful servers: tests inside a file run in
  // declaration order (the token lifecycle depends on it), one server per
  // worker, and each worker gets its own throwaway config dir.
  fullyParallel: false,
  outputDir: 'test-results',
  // The HTML report carries every MCP/HTTP exchange as a PNG screenshot —
  // browse it with `npm run e2e:report` after a run.
  reporter: process.env.CI ? [['github'], ['html', {open: 'never'}]] : [['list'], ['html', {open: 'never'}]],
  retries: process.env.CI ? 1 : 0,
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
})
