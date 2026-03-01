import { expect, test } from "@playwright/test";
import { setupApp } from "./helpers";

test.describe("Tab management", () => {
  test.beforeEach(async ({ page }) => {
    await setupApp(page);
  });

  test("switch between tabs and verify HUD updates", async ({ page }) => {
    // Initial: auth-refactor (claude-code) is focused
    await expect(page.getByAltText("claude-code")).toBeVisible();
    await expect(page.getByText("opus-4")).toBeVisible();

    // Switch to api-test (codex-cli)
    await page.getByRole("button", { name: "api-test", exact: true }).click();
    await expect(page.getByAltText("codex-cli")).toBeVisible();
    await expect(page.getByText("gpt-4o")).toBeVisible();

    // Switch to playground (gemini-cli)
    await page.getByRole("button", { name: "playground", exact: true }).click();
    await expect(page.getByAltText("gemini-cli")).toBeVisible();
    await expect(page.getByText("gemini-2.0-pro")).toBeVisible();
  });

  test("create tabs via New Tab dropdown for each provider", async ({ page }) => {
    const newTabBtn = page.getByRole("button", { name: "New Tab" });

    await newTabBtn.click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    await expect(page.getByRole("button", { name: "new-claude-tab", exact: true })).toBeVisible();

    await newTabBtn.click();
    await page.getByRole("menuitem", { name: "Codex CLI" }).click();
    await expect(page.getByRole("button", { name: "new-codex-tab", exact: true })).toBeVisible();

    await newTabBtn.click();
    await page.getByRole("menuitem", { name: "Gemini CLI" }).click();
    await expect(page.getByRole("button", { name: "new-gemini-tab", exact: true })).toBeVisible();
  });

  test("duplicate tab via context menu", async ({ page }) => {
    await page.getByRole("button", { name: "api-test", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Duplicate" }).click();

    await expect(page.getByRole("button", { name: "api-test-copy", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "api-test", exact: true })).toBeVisible();
  });

  test("close tab via context menu", async ({ page }) => {
    await page.getByRole("button", { name: "api-test", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close" }).click();

    await expect(page.getByRole("button", { name: "api-test", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "auth-refactor", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "playground", exact: true })).toBeVisible();
  });

  test("close focused tab via Ctrl+W", async ({ page }) => {
    await page.getByRole("button", { name: "api-test", exact: true }).click();
    await page.keyboard.press("Control+w");

    await expect(page.getByRole("button", { name: "api-test", exact: true })).toHaveCount(0);
  });

  test("closing focused tab falls back to sibling in same space", async ({ page }) => {
    // auth-refactor and api-test are both in Work space
    await page.getByRole("button", { name: "auth-refactor", exact: true }).click();
    await page.getByRole("button", { name: "Close tab auth-refactor" }).click();

    await expect(page.getByRole("button", { name: "auth-refactor", exact: true })).toHaveCount(0);
    // Should fallback to api-test (same space), HUD shows codex-cli
    await expect(page.getByAltText("codex-cli")).toBeVisible();
  });
});
