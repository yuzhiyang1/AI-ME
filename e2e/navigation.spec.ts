import { test, expect } from "@playwright/test";
import { loginAsDefault, openWorkspaceMenu } from "./helpers";

test.describe("Navigation", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await loginAsDefault(page);
  });

  test("sidebar navigation works", async ({ page }) => {
    // Click Inbox
    await page.getByRole("link", { name: /^Inbox/ }).click();
    await expect(page).toHaveURL(/\/inbox/, { timeout: 30_000 });

    // Click AI Workers
    await page.getByRole("link", { name: /AI Workers|AI 员工/ }).click();
    await expect(page).toHaveURL(/\/agents/, { timeout: 30_000 });

    // Click Issues
    await page.getByRole("link", { name: /^Issues$/ }).click();
    await expect(page).toHaveURL(/\/issues/, { timeout: 30_000 });
  });

  test("settings page loads via workspace menu", async ({ page }) => {
    // Settings is inside the workspace dropdown menu
    await openWorkspaceMenu(page);
    await page.locator("text=Settings").click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 30_000 });

    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI-Me Settings" })).toBeVisible();
  });

  test("agents page shows agent list", async ({ page }) => {
    await page.getByRole("link", { name: /AI Workers|AI 员工/ }).click();
    await expect(page).toHaveURL(/\/agents/, { timeout: 30_000 });

    // Should show the current worker page heading.
    await expect(page.getByRole("heading", { name: /AI Workers|AI 员工/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
