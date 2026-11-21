import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { expect, type Page } from "@playwright/test";

/**
 * Installs the E2E test signer. The secret key never enters the page: the browser calls
 * exposed functions and the signing happens here in the Node test process.
 */
export async function installTestWallet(page: Page, keypair: Keypair) {
  await page.exposeFunction("__e2eAddress", () => keypair.publicKey());
  await page.exposeFunction("__e2eSignMessage", (message: string) => Buffer.from(keypair.signMessage(message)).toString("base64"));
  await page.exposeFunction("__e2eSignTransaction", (xdr: string, passphrase: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(keypair);
    return tx.toXDR();
  });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, (...args: unknown[]) => Promise<string>>;
    (window as unknown as { __fintrixTestWallet: unknown }).__fintrixTestWallet = {
      address: () => w.__e2eAddress(),
      signMessage: (message: string) => w.__e2eSignMessage(message),
      signTransaction: (xdr: string, passphrase: string) => w.__e2eSignTransaction(xdr, passphrase),
    };
  });
}

/** Fails the test on any console error or uncaught exception in the page. */
export function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Signs in through the original landing page: Connect Wallet → Freighter card → wallet signs the challenge. */
export async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Wallet" }).first().click();
  await page.getByText("Click to connect").first().click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 60_000 });
}

/** Opens a page from the original sidebar. */
export async function openFromSidebar(page: Page, label: "Dashboard" | "Simulation" | "Marketplace" | "Deals" | "Resources") {
  await page.locator("aside").getByRole("button", { name: label, exact: true }).click();
}

export async function friendbot(address: string) {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!response.ok) throw new Error(`friendbot failed ${response.status}`);
}

export function futureDate(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
