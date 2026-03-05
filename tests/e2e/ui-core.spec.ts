import { expect, test, type Page } from "@playwright/test";

async function resetLocalStorage(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.localStorage.setItem("terminai:onboarding-complete", "true");
  });
  await page.reload();
}

test.describe("TerminAI core UI flows", () => {
  test("default path + tab actions + shortcuts + dnd", async ({ page }) => {
    await resetLocalStorage(page);

    await expect(page.getByRole("dialog", { name: "Default Run Path" })).toBeVisible();
    await page.getByRole("textbox", { name: "e.g. /Users/taehonglee/TerminAI" }).fill("/tmp");
    await page.getByRole("dialog", { name: "Default Run Path" }).getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("button", { name: "Default Path: /tmp" })).toBeVisible();

    const firstTab = page.getByRole("button", { name: "auth-refactor", exact: true });
    await firstTab.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Set Working Directory..." })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);

    await menu.getByRole("menuitem", { name: "Set Working Directory..." }).click();
    await expect(page.getByRole("dialog", { name: "Set Working Directory" })).toBeVisible();
    await page.getByRole("dialog", { name: "Set Working Directory" }).getByRole("textbox").fill("~/");
    await page.getByRole("dialog", { name: "Set Working Directory" }).getByRole("button", { name: "Save" }).click();

    await page.keyboard.press("Control+T");
    const newClaudeTab = page.getByRole("button", { name: "new-claude-tab", exact: true });
    await expect(newClaudeTab).toBeVisible();
    await page.getByRole("button", { name: "Close tab new-claude-tab" }).click();
    await expect(newClaudeTab).toHaveCount(0);

    const dragSource = page.getByRole("button", { name: "api-test", exact: true });
    const dragTarget = page.getByRole("button", { name: "playground", exact: true });
    await dragSource.dragTo(dragTarget);
    await expect(page.getByRole("status")).toContainText("was dropped over");
  });
});
