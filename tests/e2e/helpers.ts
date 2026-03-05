import type { Page } from "@playwright/test";

export async function setupApp(page: Page, defaultPath = "/tmp") {
  await page.goto("/");
  await page.evaluate((path) => {
    window.localStorage.clear();
    window.localStorage.setItem("terminai:onboarding-complete", "true");
    window.localStorage.setItem("terminai:default-cwd", JSON.stringify(path));
  }, defaultPath);
  await page.reload();

  // If Default Run Path still appears for some reason, handle it
  const dialog = page.getByRole("dialog", { name: "Default Run Path" });
  if (await dialog.isVisible()) {
    await page.getByPlaceholder("e.g. /Users/taehonglee/TerminAI").fill(defaultPath);
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "hidden" });
  }
}
