import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { contractErrorCode, explainSimulationError, fromBaseUnits, parseSignedEnvelope, toBaseUnits, usdCentsToAsset } from "../../backend/modules/chain/soroban";

describe("amount conversion", () => {
  it("converts decimal strings to stroops exactly and back", () => {
    expect(toBaseUnits("12.5")).toBe(125_000_000n);
    expect(toBaseUnits("0.0000001")).toBe(1n);
    expect(fromBaseUnits(125_000_000n)).toBe("12.5000000");
    expect(() => toBaseUnits("1.23456789")).toThrow();
    expect(() => toBaseUnits("-1")).toThrow();
  });
  it("converts USD cents at the configured rate, rounding down", () => {
    // Default rate 0.11 USD per XLM: $55.00 -> 500 XLM.
    expect(usdCentsToAsset(5500)).toBe("500.0000000");
    expect(usdCentsToAsset(1)).toBe("0.0909090");
  });
});

describe("contract error mapping", () => {
  it("maps contract error codes to readable messages", () => {
    expect(contractErrorCode("HostError: Error(Contract, #4)")).toBe(4);
    expect(explainSimulationError("HostError: Error(Contract, #4)")).toMatch(/duplicate/);
    expect(explainSimulationError("HostError: Error(Contract, #6)")).toMatch(/your own invoice/);
    expect(explainSimulationError("something else")).toMatch(/rejected/);
  });
});

describe("signed envelope check", () => {
  const signer = Keypair.random();
  const build = (fee: string) =>
    new TransactionBuilder(new Account(signer.publicKey(), "1"), { fee, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "5" }))
      .setTimeout(60)
      .build();

  it("accepts exactly the prepared transaction once signed", () => {
    const tx = build("100");
    const expected = Buffer.from(tx.hash()).toString("hex");
    tx.sign(signer);
    expect(() => parseSignedEnvelope(tx.toXDR(), expected)).not.toThrow();
  });
  it("rejects unsigned, different or malformed envelopes", () => {
    const tx = build("100");
    const expected = Buffer.from(tx.hash()).toString("hex");
    expect(() => parseSignedEnvelope(tx.toXDR(), expected)).toThrow(/not signed/);
    const other = build("200");
    other.sign(signer);
    expect(() => parseSignedEnvelope(other.toXDR(), expected)).toThrow(/does not match/);
    expect(() => parseSignedEnvelope("AAAA", expected)).toThrow(/not valid XDR/);
    // Signature validity (including signing for the wrong network) is enforced by the
    // Stellar network itself (tx_bad_auth); see the testnet integration test for real submission.
  });
});
