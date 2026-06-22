import { test, expect } from "@playwright/test";
import { startFreshGame } from "./helpers.js";

test.describe("page load", () => {
  test("header and game mode selector are visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Boots & Gloves");
    await expect(page.locator("#game-mode")).toBeVisible();
    await expect(page.locator("button:has-text('Start / Reset game')")).toBeVisible();
  });

  test("custom scorecard row is hidden by default", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#custom-game-row")).toBeHidden();
  });

  test("custom scorecard row appears when 'Custom scorecard' is selected", async ({ page }) => {
    await page.goto("/");
    await page.selectOption("#game-mode", "custom");
    await expect(page.locator("#custom-game-row")).toBeVisible();
  });
});

test.describe("game start", () => {
  test("entry columns for Team 1 and Team 2 appear after starting a fresh game", async ({ page }) => {
    await startFreshGame(page);
    await expect(page.locator(".entity-col")).toHaveCount(2);
    await expect(page.locator("#round-header")).toContainText("Round 1");
  });

  test("scoreboard shows empty state before any round is scored", async ({ page }) => {
    await startFreshGame(page);
    await expect(page.locator(".empty-state")).toContainText("No rounds yet");
  });

  test("Save buttons are enabled and labelled for each team", async ({ page }) => {
    await startFreshGame(page);
    await expect(page.locator(".btn-success").nth(0)).toContainText("Save");
    await expect(page.locator(".btn-success").nth(1)).toContainText("Save");
  });
});

test.describe("score entry", () => {
  test("round total preview updates when red books are entered", async ({ page }) => {
    await startFreshGame(page);
    // Enter 2 red books for Team 1 (entity 0)
    await page.fill("#rb-0", "2");
    // Preview should show +1000 (2 × 500)
    await expect(page.locator("#preview-0 .prev-total")).toContainText("+1000");
  });

  test("round total preview updates when black books are entered", async ({ page }) => {
    await startFreshGame(page);
    await page.fill("#bb-0", "1");
    await expect(page.locator("#preview-0 .prev-total")).toContainText("+300");
  });

  test("negative leftover cards reduce the preview total", async ({ page }) => {
    await startFreshGame(page);
    await page.fill("#nred3-0", "1");
    await expect(page.locator("#preview-0 .prev-total")).toContainText("-500");
  });

  test("checking 'went out' adds +100 win bonus to the preview", async ({ page }) => {
    await startFreshGame(page);
    // In team mode going out grants +100; leftover still applies (different from ind3)
    await page.check("#out-0");
    await expect(page.locator("#preview-0 .prev-total")).toContainText("+100");
  });
});
