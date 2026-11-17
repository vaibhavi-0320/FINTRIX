import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { findDuplicates, type InvoiceFacts } from "../../backend/modules/ml/duplicates";
import { buildFeatures, FEATURE_NAMES, loadRiskModel, scoreWithModel } from "../../backend/modules/ml/risk";
import { jaroWinkler, normaliseInvoiceNumber, normaliseName } from "../../backend/modules/ml/similarity";

describe("risk model", () => {
  const model = loadRiskModel();

  it("is trained, matches the inference feature list and records its dataset", () => {
    expect(model).not.toBeNull();
    expect(model!.features).toEqual([...FEATURE_NAMES]);
    expect(model!.dataset.synthetic).toBe(true);
    expect(model!.metrics.roc_auc).toBeGreaterThan(0.6);
  });

  it("reproduces the Python (scikit-learn) probabilities exactly", () => {
    const cases = JSON.parse(fs.readFileSync(path.resolve("ml", "reports", "parity_cases.json"), "utf8"));
    expect(cases.length).toBeGreaterThan(3);
    for (const c of cases) {
      expect(scoreWithModel(model!, c.input).score).toBeCloseTo(c.expected, 4);
    }
  });

  it("scores a worse payment history as riskier and explains the factors", () => {
    const base = { totalCents: 500_000, termsDays: 30 };
    const good = scoreWithModel(model!, { ...base, priorCount: 10, priorLateRate: 0, priorAvgDaysLate: 0 });
    const bad = scoreWithModel(model!, { ...base, priorCount: 10, priorLateRate: 0.9, priorAvgDaysLate: 25 });
    expect(bad.score).toBeGreaterThan(good.score);
    expect(bad.factors).toHaveLength(FEATURE_NAMES.length);
    expect(["low", "medium", "high"]).toContain(bad.band);
  });

  it("fills missing buyer history with training defaults", () => {
    const features = buildFeatures({ totalCents: 100, termsDays: 30, priorCount: 0, priorLateRate: null, priorAvgDaysLate: null }, { priorLateRate: 0.4, priorAvgDaysLate: 5 });
    expect(features).toMatchObject({ has_history: 0, prior_late_rate: 0.4, prior_avg_days_late: 5, log_prior_count: 0 });
  });
});

describe("duplicate detection", () => {
  const base: InvoiceFacts = { id: "a", sellerId: "s1", invoiceNumber: "INV-0042", buyerName: "Fabrikam Industries Ltd", totalCents: 500_000, currency: "USD", issueDate: "2026-05-01", documentHash: "a".repeat(64) };

  it("normalises names and invoice numbers", () => {
    expect(normaliseName("Fabrikam Industries, Ltd.")).toBe(normaliseName("FABRIKAM INDUSTRIES LIMITED"));
    expect(normaliseInvoiceNumber("INV-0042")).toBe(normaliseInvoiceNumber("#42"));
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  });

  it("flags the same document, same number+buyer and near duplicates", () => {
    expect(findDuplicates({ ...base, id: "b" }, [base])[0].rule).toBe("same_document");
    expect(findDuplicates({ ...base, id: "b", documentHash: null, invoiceNumber: "42", buyerName: "fabrikam industries limited" }, [base])[0].rule).toBe("same_number_and_buyer");
    const near = findDuplicates({ ...base, id: "b", documentHash: null, invoiceNumber: "X-9", totalCents: 501_000, issueDate: "2026-05-04" }, [base]);
    expect(near[0]).toMatchObject({ rule: "near_duplicate", severity: "medium" });
  });

  it("does not flag recurring monthly invoices or different buyers", () => {
    expect(findDuplicates({ ...base, id: "b", documentHash: null, invoiceNumber: "INV-0043", issueDate: "2026-06-01" }, [base])).toEqual([]);
    expect(findDuplicates({ ...base, id: "b", documentHash: null, invoiceNumber: "INV-0099", buyerName: "Tailspin Toys" }, [base])).toEqual([]);
    expect(findDuplicates(base, [base])).toEqual([]);
  });

  it("has the evaluated metrics on record", () => {
    const report = JSON.parse(fs.readFileSync(path.resolve("ml", "reports", "duplicates_report.json"), "utf8"));
    expect(report.dataset.synthetic).toBe(true);
    expect(report.metrics.precision).toBeGreaterThan(0.9);
    expect(report.metrics.recall).toBeGreaterThan(0.9);
  });
});
