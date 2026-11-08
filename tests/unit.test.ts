import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseReference, buildReference } from "@/lib/reference";
import { signPayload, verifyHubSignature } from "@/lib/signing";
import { eventForPayment, eventForPreapproval } from "@/lib/events";
import { verifyMpSignature } from "@/lib/mp";
import { nextDelay, MAX_ATTEMPTS } from "@/lib/delivery";
import { hashApiKey, generateCredentials } from "@/lib/apps";

describe("reference", () => {
  it("lê o prefixo do app", () => {
    expect(parseReference("studio:abc123")).toEqual({ slug: "studio", reference: "abc123" });
  });
  it("mantém dois pontos dentro da referência", () => {
    expect(parseReference("barber:a:b")).toEqual({ slug: "barber", reference: "a:b" });
  });
  it("referência antiga, sem prefixo, vem sem slug", () => {
    expect(parseReference("clx9f2")).toEqual({ slug: null, reference: "clx9f2" });
  });
  it("prefixo inválido não vira slug", () => {
    expect(parseReference("Studio X:abc")).toEqual({ slug: null, reference: "Studio X:abc" });
    expect(parseReference(":abc")?.slug).toBeNull();
  });
  it("vazio é nulo", () => {
    expect(parseReference(undefined)).toBeNull();
    expect(parseReference("")).toBeNull();
  });
  it("buildReference é o inverso", () => {
    expect(parseReference(buildReference("studio", "x1"))).toEqual({ slug: "studio", reference: "x1" });
  });
});

describe("assinatura do hub", () => {
  const secret = "whsec_teste";
  const body = JSON.stringify({ event: "payment.approved" });

  it("aceita assinatura correta", () => {
    expect(verifyHubSignature({ secret, body, header: signPayload(secret, body) })).toBe(true);
  });
  it("recusa corpo alterado, segredo errado e cabeçalho ausente", () => {
    const header = signPayload(secret, body);
    expect(verifyHubSignature({ secret, body: body + " ", header })).toBe(false);
    expect(verifyHubSignature({ secret: "outro", body, header })).toBe(false);
    expect(verifyHubSignature({ secret, body, header: null })).toBe(false);
  });
  it("recusa aviso velho (replay)", () => {
    const header = signPayload(secret, body, 1_000);
    expect(verifyHubSignature({ secret, body, header, now: 1_000 + 301 })).toBe(false);
    expect(verifyHubSignature({ secret, body, header, now: 1_000 + 299 })).toBe(true);
  });
});

describe("eventos", () => {
  it("mapeia status de pagamento", () => {
    expect(eventForPayment("approved")).toBe("payment.approved");
    expect(eventForPayment("authorized")).toBe("payment.approved");
    expect(eventForPayment("rejected")).toBe("payment.failed");
    expect(eventForPayment("cancelled")).toBe("payment.failed");
    expect(eventForPayment("refunded")).toBe("payment.refunded");
    expect(eventForPayment("charged_back")).toBe("payment.refunded");
    expect(eventForPayment("pending")).toBeNull();
    expect(eventForPayment("in_process")).toBeNull();
  });
  it("mapeia assinatura", () => {
    expect(eventForPreapproval("cancelled")).toBe("subscription.cancelled");
    expect(eventForPreapproval("paused")).toBe("subscription.paused");
    expect(eventForPreapproval("authorized")).toBeNull();
  });
});

describe("assinatura do Mercado Pago", () => {
  const secret = "mp-secret";
  const sign = (dataId: string, requestId: string, ts: string) =>
    `ts=${ts},v1=${createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex")}`;

  it("aceita a assinatura correta", () => {
    expect(
      verifyMpSignature({ secret, dataId: "123", requestId: "req-1", signatureHeader: sign("123", "req-1", "1700000000") })
    ).toBe(true);
  });
  it("recusa id diferente, header ausente e segredo errado", () => {
    const header = sign("123", "req-1", "1700000000");
    expect(verifyMpSignature({ secret, dataId: "124", requestId: "req-1", signatureHeader: header })).toBe(false);
    expect(verifyMpSignature({ secret, dataId: "123", requestId: "req-1", signatureHeader: null })).toBe(false);
    expect(verifyMpSignature({ secret: "x", dataId: "123", requestId: "req-1", signatureHeader: header })).toBe(false);
  });
  it("sem segredo configurado recusa (a não ser no modo desenvolvimento)", () => {
    const saved = { s: process.env.MP_WEBHOOK_SECRET, a: process.env.ALLOW_UNSIGNED_WEBHOOKS };
    delete process.env.MP_WEBHOOK_SECRET;
    delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    expect(verifyMpSignature({ dataId: "1", requestId: null, signatureHeader: null })).toBe(false);
    process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
    expect(verifyMpSignature({ dataId: "1", requestId: null, signatureHeader: null })).toBe(true);
    if (saved.s !== undefined) process.env.MP_WEBHOOK_SECRET = saved.s;
    if (saved.a === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
    else process.env.ALLOW_UNSIGNED_WEBHOOKS = saved.a;
  });
});

describe("retry e credenciais", () => {
  it("espera cada vez mais e desiste depois da última", () => {
    expect(nextDelay(1)).toBe(60_000);
    expect(nextDelay(5)).toBe(12 * 3_600_000);
    expect(nextDelay(MAX_ATTEMPTS)).toBeNull();
  });
  it("a chave do app só existe em claro na criação", () => {
    const a = generateCredentials();
    expect(a.apiKey.startsWith("npk_")).toBe(true);
    expect(a.apiKeyHash).toBe(hashApiKey(a.apiKey));
    expect(a.apiKeyHash).not.toContain(a.apiKey);
    expect(generateCredentials().apiKey).not.toBe(a.apiKey);
  });
});
