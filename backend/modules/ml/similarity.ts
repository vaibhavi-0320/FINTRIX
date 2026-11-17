/** Normalises company names so "ACME Corp., Ltd" and "acme corp ltd" compare equal. */
export function normaliseName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pvt|private|sa|ag|bv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalises invoice numbers: "INV-0042" == "inv 42" == "#42". */
export function normaliseInvoiceNumber(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.replace(/^(INVOICE|INV|NO|NUM)/, "").replace(/^0+(?=\d)/, "");
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function daysBetween(a: string, b: string) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}
