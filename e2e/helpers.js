// Shared E2E helpers
// Each test gets its own Firebase game code (derived from the running test's
// unique id) so tests never touch the real scorecards *and* parallel workers
// never collide on the same game document — a shared fixed code caused tests
// to stomp on each other's Firebase state when run with multiple workers.
import { test } from "@playwright/test";

// testId looks like "<shared-file-hash>-<per-test-hash>" — only the segment
// after the hyphen actually varies per test, and #custom-game-id has
// maxlength=20, so use that segment directly rather than a prefix + slice
// (which silently truncated down to the non-unique shared part).
export function testCode() {
  const id = test.info().testId;
  return id.slice(id.lastIndexOf("-") + 1).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Navigates to the app, selects the custom game mode, fills in this test's
 * unique game code, clicks "Start / Reset game", and accepts the confirm
 * dialog (start fresh). Returns once the entry columns are visible.
 */
export async function startFreshGame(page) {
  // Accept any confirm dialogs automatically (always start fresh for tests)
  page.on("dialog", dialog => dialog.accept());

  await page.goto("/");
  await page.waitForSelector("#game-mode");

  await page.selectOption("#game-mode", "custom");
  await page.waitForSelector("#custom-game-row", { state: "visible" });
  await page.selectOption("#custom-mode", "team2v2");
  await page.fill("#custom-game-id", testCode());
  await page.click("button:has-text('Start / Reset game')");

  // Entry columns appear once the game is written to Firebase and rendered
  await page.waitForSelector(".entity-col", { timeout: 15_000 });
}

/**
 * Opens a new page in `context` pre-loaded with this test's game code in
 * localStorage so the auto-restore IIFE connects it to the same Firebase
 * game as Device A (must be called from within the same test as startFreshGame).
 */
export async function joinGame(context) {
  const code = testCode();
  const page = await context.newPage();
  await page.addInitScript(({ id, code }) => {
    localStorage.setItem("bnag-lastGameId",   id);
    localStorage.setItem("bnag-lastGameCode", code);
  }, { id: "bnag-" + code, code });
  await page.goto("/");
  await page.waitForSelector(".entity-col", { timeout: 15_000 });
  return page;
}

/** Wait until the sync status badge shows "● synced". */
export async function waitForSync(page, timeout = 10_000) {
  await page.waitForFunction(
    () => document.getElementById("sync-status")?.textContent.includes("synced"),
    { timeout }
  );
}
