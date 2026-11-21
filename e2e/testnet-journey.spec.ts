/**
 * Full journey through the ORIGINAL Fintrix UI on REAL Stellar testnet:
 * seller uploads + lists → investor simulates → investor funds → seller repays → investor claims.
 * Opt-in: npm run test:e2e:testnet
 */
import path from "path";
import fs from "fs";
import os from "os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Keypair } from "@stellar/stellar-sdk";
import { expect, test, type Page } from "@playwright/test";
import { collectConsoleErrors, friendbot, futureDate, installTestWallet, openFromSidebar, signInThroughUi } from "./helpers";

test.skip(process.env.E2E_TESTNET !== "1", "set E2E_TESTNET=1 to run against Stellar testnet");
test.setTimeout(420_000);

/** A unique, synthetic, small ($44) invoice so the on-chain duplicate check never blocks a rerun. */
async function makeInvoicePdf(invoiceNumber: string, buyer: string) {
  const lines = [
    "E2E Seller Ltd", "1 Test Street, Bristol, UK", "", "INVOICE",
    `Invoice No: ${invoiceNumber}`, `Invoice Date: ${futureDate(0)}`, `Due Date: ${futureDate(45)}`, "",
    "Bill To:", buyer, "2 Demo Avenue, Seattle, WA", "",
    "Description Qty Unit Price Amount", "Consulting hours 1 40.00 40.00", "",
    "Subtotal USD 40.00", "Tax (10%) USD 4.00", "Total Due USD 44.00",
  ];
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => line && page.drawText(line, { x: 50, y: 790 - i * 20, size: 12, font }));
  const file = path.join(os.tmpdir(), `${invoiceNumber}.pdf`);
  fs.writeFileSync(file, await pdf.save());
  return file;
}

async function openDeal(page: Page, buyer: string) {
  await openFromSidebar(page, "Marketplace");
  await page.getByPlaceholder("Search Invoices...").fill(buyer);
  await page.getByRole("button", { name: "View Details" }).first().click();
}

async function confirmAction(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click();
}

test("seller lists, investor simulates and funds, seller repays, investor claims", async ({ browser }) => {
  const seller = Keypair.random();
  const investor = Keypair.random();
  await Promise.all([friendbot(seller.publicKey()), friendbot(investor.publicKey())]);
  const stamp = Date.now();
  const invoiceNumber = `E2E-${stamp}`;
  const buyer = `E2E Buyer ${stamp}`;
  const pdf = await makeInvoicePdf(invoiceNumber, buyer);
  const dismiss = (page: Page) => page.on("dialog", (dialog) => void dialog.dismiss());

  // ---- Seller: Simulation → Upload Invoice → review → list on-chain.
  const sellerPage = await (await browser.newContext()).newPage();
  const sellerErrors = collectConsoleErrors(sellerPage);
  dismiss(sellerPage);
  await installTestWallet(sellerPage, seller);
  await signInThroughUi(sellerPage);
  await openFromSidebar(sellerPage, "Simulation");
  await sellerPage.locator('input[type="file"]').setInputFiles(pdf);
  await expect(sellerPage.getByText(invoiceNumber).first()).toBeVisible({ timeout: 60_000 });
  await expect(sellerPage.getByText("$44.00").first()).toBeVisible();
  await sellerPage.getByRole("button", { name: /Confirm fields & list on marketplace/ }).click();
  await expect(sellerPage.getByText("Listed on Stellar testnet")).toBeVisible({ timeout: 120_000 });

  // ---- Investor: simulate on the new deal, then fund it from the marketplace.
  const investorPage = await (await browser.newContext()).newPage();
  const investorErrors = collectConsoleErrors(investorPage);
  dismiss(investorPage);
  await installTestWallet(investorPage, investor);
  await signInThroughUi(investorPage);
  await openFromSidebar(investorPage, "Simulation");
  const select = investorPage.locator("#simulator-section select, select").last();
  const value = await select.locator("option", { hasText: buyer }).getAttribute("value");
  await select.selectOption(value!);
  await investorPage.getByRole("button", { name: "Simulate on Testnet ▷" }).click();
  await expect(investorPage.getByText("✓ Simulation recorded on-chain")).toBeVisible({ timeout: 120_000 });

  await openDeal(investorPage, buyer);
  await confirmAction(investorPage, "FUND THIS INVOICE");
  await expect(investorPage.getByText("Confirmed on Stellar testnet")).toBeVisible({ timeout: 120_000 });

  // ---- Seller repays into escrow → Repayment Complete screen.
  await openDeal(sellerPage, buyer);
  await confirmAction(sellerPage, "REPAY INTO ESCROW");
  await expect(sellerPage.getByRole("heading", { name: "Repayment Complete" })).toBeVisible({ timeout: 120_000 });

  // ---- Investor claims; the deal settles.
  await openDeal(investorPage, buyer);
  await confirmAction(investorPage, "CLAIM REPAYMENT");
  await expect(investorPage.getByText("Confirmed on Stellar testnet")).toBeVisible({ timeout: 120_000 });
  await expect(investorPage.getByRole("button", { name: "SETTLED" })).toBeVisible();

  const unexpected = (errors: string[]) => errors.filter((error) => !/Failed to load resource/.test(error));
  expect(unexpected(sellerErrors)).toEqual([]);
  expect(unexpected(investorErrors)).toEqual([]);
});
