import { expect, test } from "@playwright/test";
import { setupApp } from "./helpers";

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await setupApp(page);
  });

  test("collapse and expand space groups", async ({ page }) => {
    // Work and Personal groups should be visible with tabs
    await expect(page.getByRole("button", { name: "auth-refactor", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "api-test", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "playground", exact: true })).toBeVisible();

    // Collapse Work group
    await page.getByRole("button", { name: "Work" }).click();
    await expect(page.getByRole("button", { name: "auth-refactor", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "api-test", exact: true })).toHaveCount(0);
    // Personal tabs still visible
    await expect(page.getByRole("button", { name: "playground", exact: true })).toBeVisible();

    // Expand Work group again
    await page.getByRole("button", { name: "Work" }).click();
    await expect(page.getByRole("button", { name: "auth-refactor", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "api-test", exact: true })).toBeVisible();

    // Collapse Personal group
    await page.getByRole("button", { name: "Personal" }).click();
    await expect(page.getByRole("button", { name: "playground", exact: true })).toHaveCount(0);

    // Expand Personal group
    await page.getByRole("button", { name: "Personal" }).click();
    await expect(page.getByRole("button", { name: "playground", exact: true })).toBeVisible();
  });

  test("sidebar resize via drag handle", async ({ page }) => {
    const handle = page.getByRole("button", { name: "Resize sidebar" });
    const box = await handle.boundingBox();
    if (!box) throw new Error("Resize handle not found");

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Drag right to widen sidebar
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 5 });
    await page.mouse.up();

    // Verify sidebar got wider by checking the new handle position
    const newBox = await handle.boundingBox();
    if (!newBox) throw new Error("Resize handle not found after drag");
    expect(newBox.x).toBeGreaterThan(box.x + 40);
  });

  test("default path button shows configured path", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Default Path: /tmp" })).toBeVisible();
  });
});

test.describe("HUD Panel", () => {
  test.beforeEach(async ({ page }) => {
    await setupApp(page);
  });

  test("cycle through compact → expanded → hidden → compact", async ({ page }) => {
    // Compact mode: shows provider icon, model, status
    const hudButton = page.getByRole("button", { name: /claude-code/ });
    await expect(hudButton).toBeVisible();
    await expect(page.getByText("opus-4")).toBeVisible();

    // Click → expanded: shows extra details
    await hudButton.click();
    await expect(page.getByText(/Tools:/)).toBeVisible();
    await expect(page.getByText(/Tokens:/)).toBeVisible();
    await expect(page.getByText(/Rate:/)).toBeVisible();
    await expect(page.getByText(/Session:/)).toBeVisible();

    // Click → hidden: just "Show HUD" button
    await hudButton.click();
    await expect(page.getByRole("button", { name: "Show HUD" })).toBeVisible();
    await expect(page.getByText("opus-4")).toHaveCount(0);

    // Click "Show HUD" → back to compact
    await page.getByRole("button", { name: "Show HUD" }).click();
    await expect(page.getByText("opus-4")).toBeVisible();
  });

  test("HUD reflects provider of focused tab", async ({ page }) => {
    // auth-refactor (claude-code)
    await expect(page.getByAltText("claude-code")).toBeVisible();
    await expect(page.getByText("opus-4")).toBeVisible();

    // api-test (codex-cli)
    await page.getByRole("button", { name: "api-test", exact: true }).click();
    await expect(page.getByAltText("codex-cli")).toBeVisible();
    await expect(page.getByText("gpt-4o")).toBeVisible();

    // playground (gemini-cli)
    await page.getByRole("button", { name: "playground", exact: true }).click();
    await expect(page.getByAltText("gemini-cli")).toBeVisible();
    await expect(page.getByText("gemini-2.0-pro")).toBeVisible();
  });

  test("HUD shows elapsed time", async ({ page }) => {
    // HUD shows duration in format "Xm" or "Xh Ym"
    await expect(page.getByText(/\d+m/)).toBeVisible();
  });
});
