import path from "path";
import { Keypair } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";
import { collectConsoleErrors, installTestWallet, openFromSidebar, signInThroughUi } from "./helpers";

test("landing page and wallet modal load without console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect Wallet" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Connect Wallet" }).first().click();
  await expect(page.getByRole("heading", { name: "Connect Your Wallet" })).toBeVisible();
  await expect(page.getByText("Freighter Wallet")).toBeVisible();
  await expect(page.getByText("Albedo Wallet")).toBeVisible();
  expect(errors).toEqual([]);
});

test("sign in, browse every page, upload → real extraction → review, sign out", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  page.on("dialog", (dialog) => void dialog.dismiss());
  await installTestWallet(page, Keypair.random());
  await signInThroughUi(page);

  // Real dashboard data for a brand-new wallet: nothing invented.
  await expect(page.getByText("SIMULATIONS RUN", { exact: false })).toBeVisible();
  await expect(page.getByText("Not funded")).toBeVisible();

  await openFromSidebar(page, "Marketplace");
  await expect(page.getByRole("heading", { name: "Invoice Opportunities" })).toBeVisible();
  await expect(page.getByText("TechLogistics Ltd")).toHaveCount(0); // old hardcoded fallback deals are gone

  await openFromSidebar(page, "Resources");
  await openFromSidebar(page, "Simulation");
  await expect(page.getByRole("heading", { name: "Model invoice returns before funding" })).toBeVisible();

  // Upload the synthetic sample invoice: values must come from the document, not random mocks.
  await page.locator('input[type="file"]').setInputFiles(path.resolve("tests/fixtures/invoice-sample.pdf"));
  await expect(page.getByText(/Invoice Parsed Successfully \(local:pdf-text\)/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("INV-2026-0417").first()).toBeVisible();
  await expect(page.getByText("Northwind Components Ltd").first()).toBeVisible();
  await expect(page.getByText("$1,382.40").first()).toBeVisible();
  await expect(page.getByText("REVIEW EXTRACTED FIELDS")).toBeVisible();

  // Listing needs a funded testnet account; the real error from the network simulation is shown.
  await page.getByRole("button", { name: /Confirm fields & list on marketplace/ }).click();
  await expect(page.getByText(/not activated on testnet/)).toBeVisible({ timeout: 60_000 });

  // Assistant: sends the screen the user is on; without an AI key it says so and lists related articles.
  await page.getByRole("button", { name: "Open Fintrix AI assistant" }).click();
  const sent = page.waitForRequest((request) => /\/api\/assistant\/conversations\/[^/]+\/messages$/.test(request.url()));
  await page.getByPlaceholder(/Ask about wallets, funding/).fill("What is a Trust Score?");
  await page.getByRole("button", { name: "Send" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ content: "What is a Trust Score?", context: { view: "simulation" } });
  await expect(page.getByText(/AI is not configured on this server/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Related help articles:/)).toBeVisible();
  await page.getByRole("button", { name: "Open Fintrix AI assistant" }).click();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect Wallet" }).first()).toBeVisible();
  expect(errors.filter((error) => !/Failed to load resource/.test(error))).toEqual([]);
});
