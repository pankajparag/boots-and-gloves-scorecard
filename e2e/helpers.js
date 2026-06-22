// Shared E2E helpers
// Uses a dedicated Firebase game code so tests never touch the real scorecards.
export const TEST_CODE = "e2etest";
export const TEST_ID   = "bnag-e2etest";

/**
 * Navigates to the app, selects the custom game mode, fills in TEST_CODE,
 * clicks "Start / Reset game", and accepts the confirm dialog (start fresh).
 * Returns once the entry columns are visible.
 */
export async function startFreshGame(page) {
  // Accept any confirm dialogs automatically (always start fresh for tests)
  page.on("dialog", dialog => dialog.accept());

  await page.goto("/");
  await page.waitForSelector("#game-mode");

  await page.selectOption("#game-mode", "custom");
  await page.waitForSelector("#custom-game-row", { state: "visible" });
  await page.selectOption("#custom-mode", "team2v2");
  await page.fill("#custom-game-id", TEST_CODE);
  await page.click("button:has-text('Start / Reset game')");

  // Entry columns appear once the game is written to Firebase and rendered
  await page.waitForSelector(".entity-col", { timeout: 15_000 });
}

/**
 * Opens a new page in `context` pre-loaded with the test game's localStorage
 * so the auto-restore IIFE connects it to the same Firebase game as Device A.
 */
export async function joinGame(context) {
  const page = await context.newPage();
  await page.addInitScript(({ id, code }) => {
    localStorage.setItem("bnag-lastGameId",   id);
    localStorage.setItem("bnag-lastGameCode", code);
  }, { id: TEST_ID, code: TEST_CODE });
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
