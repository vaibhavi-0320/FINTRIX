import { Keypair } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";
import { installTestWallet, signInThroughUi } from "./helpers";

test("original UI works at phone width", async ({ page }) => {
  await installTestWallet(page, Keypair.random());
  await signInThroughUi(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
