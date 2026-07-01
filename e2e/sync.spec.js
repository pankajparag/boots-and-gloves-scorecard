/**
 * Multi-device sync tests — simulate two independent browsers connecting to
 * the same Firebase game (the way two teams would use the scorecard).
 *
 * Device A = the browser that starts the game and enters Team 1 scores.
 * Device B = a second browser context that joins and enters Team 2 scores.
 *
 * PREREQUISITE: Firebase Realtime Database rules must allow the "drafts/" path.
 * Add this to your rules in the Firebase Console → Realtime Database → Rules:
 *
 *   "drafts": { ".read": true, ".write": true }
 *
 * If the path is blocked these tests are skipped automatically with a clear message.
 */
import { test, expect } from "@playwright/test";
import { startFreshGame, joinGame, waitForSync } from "./helpers.js";

// Detect whether the Firebase "drafts/" path is accessible before running any
// sync test — skip the whole suite with a helpful message if not.
let draftsAllowed = true;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const permDenied = [];
  page.on("console", m => {
    if (m.text().includes("permission_denied")) permDenied.push(true);
  });
  await startFreshGame(page);
  await page.fill("#rb-0", "1");          // triggers scheduleDraftPush
  await page.waitForTimeout(1500);        // wait for 400ms debounce + network
  draftsAllowed = permDenied.length === 0;
  await ctx.close();
});

test.beforeEach(async ({}, testInfo) => {
  if (!draftsAllowed) {
    testInfo.skip(true,
      'Firebase rules do not allow the "drafts/" path. ' +
      'In the Firebase Console → Realtime Database → Rules add: ' +
      '"drafts": { ".read": true, ".write": true }');
  }
});

test.describe("live draft sync", () => {
  test("values typed on Device A appear on Device B within 5 s", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await startFreshGame(pageA);
    await waitForSync(pageA);

    const ctxB = await browser.newContext();
    const pageB = await joinGame(ctxB);

    // Device A types 3 red books for Team 1
    await pageA.fill("#rb-0", "3");

    // Device B should see 3 appear in Team 1's red-books field (via draft sync)
    await expect(pageB.locator("#rb-0")).toHaveValue("3", { timeout: 8_000 });

    // The "entering…" badge should have appeared on Device B for Team 1's column
    await expect(pageB.locator("#col-0 .draft-badge")).toBeVisible({ timeout: 8_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test("multiple fields sync from Device A to Device B", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await startFreshGame(pageA);
    await waitForSync(pageA);

    const ctxB = await browser.newContext();
    const pageB = await joinGame(ctxB);

    await pageA.fill("#rb-0",    "1");
    await pageA.fill("#bb-0",    "2");
    await pageA.fill("#pjoker-0","1");

    await expect(pageB.locator("#rb-0")).toHaveValue("1", { timeout: 8_000 });
    await expect(pageB.locator("#bb-0")).toHaveValue("2", { timeout: 8_000 });
    await expect(pageB.locator("#pjoker-0")).toHaveValue("1", { timeout: 8_000 });

    await ctxA.close();
    await ctxB.close();
  });
});

test.describe("save propagation", () => {
  test("saving Team 1 on Device A marks it as saved on Device B", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await startFreshGame(pageA);
    await waitForSync(pageA);

    const ctxB = await browser.newContext();
    const pageB = await joinGame(ctxB);

    // Device A enters a score and saves Team 1
    await pageA.fill("#rb-0", "1");
    await pageA.click("#col-0 .btn-success");

    // Device B should see Team 1's column become saved (Save button turns grey)
    await expect(pageB.locator("#col-0 .btn-saved")).toBeVisible({ timeout: 8_000 });
    // And Team 1's inputs should be disabled on Device B
    await expect(pageB.locator("#rb-0")).toBeDisabled({ timeout: 8_000 });

    await ctxA.close();
    await ctxB.close();
  });
});

test.describe("round finalization", () => {
  test("round advances for both devices after both teams save", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await startFreshGame(pageA);
    await waitForSync(pageA);

    const ctxB = await browser.newContext();
    const pageB = await joinGame(ctxB);

    // Device A saves Team 1 with 1 red book
    await pageA.fill("#rb-0", "1");
    await pageA.click("#col-0 .btn-success");

    // Before Team 2 saves, both devices should see a live "(draft)" row for
    // Round 1: Team 1's committed total, Team 2 still pending.
    await expect(pageA.locator(".score-row.draft-row .round-label")).toContainText("(draft)", { timeout: 8_000 });
    await expect(pageB.locator(".score-row.draft-row .round-label")).toContainText("(draft)", { timeout: 8_000 });
    const draftValsA = pageA.locator(".score-row.draft-row .score-val");
    const draftValsB = pageB.locator(".score-row.draft-row .score-val");
    await expect(draftValsA.nth(0)).toContainText("500");
    await expect(draftValsA.nth(1)).toContainText("—");
    await expect(draftValsB.nth(0)).toContainText("500");
    await expect(draftValsB.nth(1)).toContainText("—");

    // Device B marks a Team 2 player as having gone out — a round only
    // finalizes once exactly one player is recorded as going out.
    await pageB.check("#out-2");
    // Device B saves Team 2 with 1 black book
    await pageB.fill("#bb-1", "1");
    await pageB.click("#col-1 .btn-success");

    // Both devices should now be on Round 2
    await expect(pageA.locator("#round-header")).toHaveText("Round 2", { timeout: 15_000 });
    await expect(pageB.locator("#round-header")).toHaveText("Round 2", { timeout: 15_000 });

    // Round 1 should appear in both scoreboards
    await expect(pageA.locator(".round-label").first()).toContainText("Round 1");
    await expect(pageB.locator(".round-label").first()).toContainText("Round 1");

    // Scores should be correct: Team 1 = +500, Team 2 = +300 black book + 100 win
    const scoresA = pageA.locator(".score-val").filter({ hasNotText: "Total" });
    await expect(scoresA.nth(0)).toContainText("500");
    await expect(scoresA.nth(1)).toContainText("400");

    await ctxA.close();
    await ctxB.close();
  });

  test("Device B can save first, then Device A triggers finalization", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await startFreshGame(pageA);
    await waitForSync(pageA);

    const ctxB = await browser.newContext();
    const pageB = await joinGame(ctxB);

    // Device B saves first
    await pageB.fill("#bb-1", "2");
    await pageB.click("#col-1 .btn-success");

    // Small pause to ensure B's save is in Firebase before A saves
    await pageA.waitForTimeout(1_000);

    // Device A marks a player as having gone out. This must propagate to
    // Team 2's already-committed (but winnerless) draft too, or the round
    // would never finalize — regression coverage for a deadlock where an
    // entity saved before anyone was marked as going out froze at outPi:-1.
    await pageA.check("#out-0");

    // Device A saves second — this should trigger finalization
    await pageA.fill("#rb-0", "2");
    await pageA.click("#col-0 .btn-success");

    await expect(pageA.locator("#round-header")).toHaveText("Round 2", { timeout: 15_000 });
    await expect(pageB.locator("#round-header")).toHaveText("Round 2", { timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
  });
});
