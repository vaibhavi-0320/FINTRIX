import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { extractedInvoiceSchema } from "./modules/documents/schema";

const strippedTextOptions: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

/** Strips markup and control characters and collapses whitespace in free text. */
export function sanitizeString(value: string) {
  return sanitizeHtml(value, strippedTextOptions)
    // eslint-disable-next-line no-control-regex -- intentionally strips ASCII control characters
    .replace(/[\u0000-\u001f\u007f<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const text = (max: number) => z.string().transform(sanitizeString).pipe(z.string().min(1).max(max));
const optionalText = (max: number) => z.string().transform(sanitizeString).pipe(z.string().max(max)).nullable().optional();

export const stellarPublicKeySchema = z.string().trim().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar public key.");
export const uuidSchema = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Invalid date.");
const money = z.number().finite().min(0).max(100_000_000);

export const challengeSchema = z.object({ address: stellarPublicKeySchema }).strict();

export const verifySchema = z
  .object({
    address: stellarPublicKeySchema,
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    // base64/hex string (Freighter v4+) or a serialised Buffer (v3).
    signature: z.union([z.string().min(64).max(200), z.object({ type: z.literal("Buffer"), data: z.array(z.number().int().min(0).max(255)).length(64) })]),
    /** Albedo only: hex of the exact bytes Albedo signed (derived from address + challenge). */
    signedMessage: z.string().regex(/^[0-9a-fA-F]+$/).max(8192).optional(),
  })
  .strict();

export const profileSchema = z.object({ displayName: optionalText(80) }).strict();

const lineItem = z
  .object({
    description: text(300),
    quantity: z.number().finite().nullable(),
    unitPrice: z.number().finite().nullable(),
    amount: z.number().finite().nullable(),
  })
  .strict();

export const invoiceInputSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9#._:/\- ]+$/, "Invoice number contains invalid characters."),
    issuerName: text(160),
    buyerName: text(160),
    buyerCountry: z.string().regex(/^[A-Z]{2}$/, "Use a 2-letter ISO country code.").nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code."),
    issueDate: isoDate,
    dueDate: isoDate,
    subtotal: money.nullable().optional(),
    tax: money.nullable().optional(),
    total: z.number().finite().positive().max(100_000_000),
    lineItems: z.array(lineItem).max(100).optional(),
    discountBps: z.number().int().min(0).max(3000),
    notes: optionalText(1000),
  })
  .strict();

export const invoiceListQuerySchema = z.object({
  scope: z.enum(["mine", "marketplace", "investments", "all"]).default("all"),
  status: z.enum(["draft", "listed", "funded", "repaid", "settled", "cancelled", "defaulted"]).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const simulationSchema = z
  .object({
    invoiceId: uuidSchema,
    amountUSD: z.number().finite().positive().max(10_000_000),
    expectedReturn: z.number().finite().min(0).max(10_000_000),
    maturityDate: isoDate,
  })
  .strict();

export const chainActionSchema = z.enum(["create", "fund", "repay", "claim", "cancel", "default"]);

export const submitSchema = z
  .object({ signedXdr: z.string().trim().min(100).max(40_000).regex(/^[A-Za-z0-9+/=]+$/, "Signed transaction must be base64 XDR.") })
  .strict();

export const reExtractSchema = z.object({ engine: z.enum(["claude", "local"]).optional() }).strict();

export const reviewSchema = z.object({ fields: extractedInvoiceSchema }).strict();

export const extractionToInvoiceSchema = z
  .object({
    discountBps: z.number().int().min(0).max(3000),
    notes: optionalText(1000),
    buyerCountry: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  })
  .strict();

export const audienceSchema = z.enum(["user", "beginner", "developer", "investor", "judge"]);

export const conversationCreateSchema = z.object({ audience: audienceSchema.default("user") }).strict();
export const conversationPatchSchema = z.object({ audience: audienceSchema.optional(), title: text(120).optional() }).strict();
export const messageSchema = z
  .object({
    content: z.string().trim().min(1, "Type a message.").max(4000),
    context: z
      .object({
        view: z.enum(["landing", "wallet", "dashboard", "marketplace", "deal-detail", "simulation", "resources", "funding-success", "repayment"]).optional(),
        invoiceId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
