import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:8080",
    headless: true,
    // Give Firebase round-trips generous time
    actionTimeout: 10_000,
  },
  webServer: {
    command: "python3 -m http.server 8080",
    url: "http://localhost:8080",
    reuseExistingServer: true,
    timeout: 8_000,
  },
});
