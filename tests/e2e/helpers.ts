import type { Page } from "@playwright/test";

export async function setupApp(page: Page, defaultPath = "/tmp") {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const dialog = page.getByRole("dialog", { name: "Default Run Path" });
  await dialog.waitFor({ state: "visible" });
  await page.getByPlaceholder("e.g. /Users/taehonglee/TerminAI").fill(defaultPath);
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "hidden" });
}
