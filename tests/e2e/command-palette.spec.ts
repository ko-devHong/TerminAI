import { expect, test } from "@playwright/test";
import { setupApp } from "./helpers";

test.describe("Command Palette", () => {
  test.beforeEach(async ({ page }) => {
    await setupApp(page);
  });

  test("open with Cmd+K and close with Escape", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command Palette" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("open via Search button click", async ({ page }) => {
    await page.getByRole("button", { name: /Search/ }).click();
    await expect(page.getByRole("dialog", { name: "Command Palette" })).toBeVisible();
  });

  test("search filter narrows results", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command Palette" });

    // Initially shows Quick Actions and all 3 tabs
    await expect(dialog.getByText("Quick Actions")).toBeVisible();
    await expect(dialog.getByRole("option", { name: /auth-refactor/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /api-test/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /playground/ })).toBeVisible();

    // Type "api" → only api-test matches
    await dialog.getByPlaceholder("Search commands, tabs, spaces...").fill("api");
    await expect(dialog.getByRole("option", { name: /api-test/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /auth-refactor/ })).toHaveCount(0);
    await expect(dialog.getByRole("option", { name: /playground/ })).toHaveCount(0);
  });

  test("select tab via palette navigates to it", async ({ page }) => {
    // Start on auth-refactor (claude-code)
    await expect(page.getByAltText("claude-code")).toBeVisible();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command Palette" });

    // Search for playground and select it
    await dialog.getByPlaceholder("Search commands, tabs, spaces...").fill("playground");
    await page.keyboard.press("Enter");

    // Palette closes, playground (gemini-cli) is now focused
    await expect(dialog).toHaveCount(0);
    await expect(page.getByAltText("gemini-cli")).toBeVisible();
  });

  test("create tab via Quick Actions", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command Palette" });

    await dialog.getByRole("option", { name: /New Codex Tab/ }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "new-codex-tab", exact: true })).toBeVisible();
    await expect(page.getByAltText("codex-cli")).toBeVisible();
  });
});
