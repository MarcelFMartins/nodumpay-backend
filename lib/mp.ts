import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

const API = process.env.MP_API_URL ?? "https://api.mercadopago.com";

export class MercadoPagoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MercadoPagoError";
  }
}

export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MP_ACCESS_TOKEN);
}

async function call<T>(
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: unknown; idempotencyKey?: string }
): Promise<T> {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new MercadoPagoError("MP_ACCESS_TOKEN não configurado");

  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.idempotencyKey ? { "X-Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON: segue com o texto cru na mensagem
  }

  if (!response.ok) {
    const detail =
      (json as { message?: string } | null)?.message ?? text.slice(0, 200) ?? response.statusText;
    throw new MercadoPagoError(`Mercado Pago ${response.status}: ${detail}`, response.status);
  }
  return json as T;
}

// --------------------------- Pagamento -------------------------

export interface PaymentResponse {
  id: number;
  status:
    | "pending"
    | "approved"
    | "authorized"
    | "in_process"
    | "rejected"
    | "refunded"
    | "cancelled"
    | "charged_back";
  transaction_amount: number;
  payment_method_id?: string;
  external_reference?: string;
  date_approved?: string | null;
  preapproval_id?: string;
}

export function getPayment(id: string | number): Promise<PaymentResponse> {
  return call<PaymentResponse>(`/v1/payments/${id}`, { method: "GET" });
}

// --------------------------- Assinatura recorrente -------------

export interface PreapprovalResponse {
  id: string;
  status: "pending" | "authorized" | "paused" | "cancelled";
  external_reference?: string;
  init_point?: string;
  payer_email?: string;
  reason?: string;
  next_payment_date?: string | null;
  auto_recurring?: { frequency?: number; frequency_type?: string; transaction_amount?: number };
}

export function getPreapproval(id: string): Promise<PreapprovalResponse> {
  return call<PreapprovalResponse>(`/preapproval/${encodeURIComponent(id)}`, { method: "GET" });
}

/**
 * Assinatura no cartão: o cliente abre `init_point`, cadastra o cartão e o
 * Mercado Pago passa a cobrar sozinho a cada `frequencyMonths` meses. Os
 * pagamentos gerados chegam ao webhook do hub (o da aplicação no MP).
 */
export function createPreapproval(params: {
  reason: string;
  payerEmail: string;
  amountBRL: number;
  frequencyMonths: number;
  externalReference: string;
  backUrl?: string;
  idempotencyKey: string;
}): Promise<PreapprovalResponse> {
  return call<PreapprovalResponse>("/preapproval", {
    method: "POST",
    idempotencyKey: params.idempotencyKey,
    body: {
      reason: params.reason,
      external_reference: params.externalReference,
      payer_email: params.payerEmail,
      ...(isPublicHttps(params.backUrl) ? { back_url: params.backUrl } : {}),
      auto_recurring: {
        frequency: params.frequencyMonths,
        frequency_type: "months",
        transaction_amount: params.amountBRL,
        currency_id: "BRL",
      },
      status: "pending",
    },
  });
}

export function cancelPreapproval(id: string): Promise<PreapprovalResponse> {
  return call<PreapprovalResponse>(`/preapproval/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { status: "cancelled" },
  });
}

// --------------------------- Cobrança (checkout) ---------------

export interface PreferenceResponse {
  id: string;
  init_point: string;
}

function isPublicHttps(url: string | undefined | null): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function createPreference(params: {
  title: string;
  amountBRL: number;
  payerEmail: string;
  externalReference: string;
  idempotencyKey: string;
  onlyPix?: boolean;
  backUrl?: string;
  notificationUrl?: string;
}): Promise<PreferenceResponse> {
  const back = isPublicHttps(params.backUrl) ? params.backUrl : null;
  const notification = isPublicHttps(params.notificationUrl) ? params.notificationUrl : null;

  if (!back) logger.warn("Cobrança criada sem back_url HTTPS — sem retorno automático ao app");
  if (!notification) logger.warn("Cobrança criada sem notification_url HTTPS pública");

  return call<PreferenceResponse>("/checkout/preferences", {
    method: "POST",
    idempotencyKey: params.idempotencyKey,
    body: {
      items: [
        { title: params.title, quantity: 1, unit_price: params.amountBRL, currency_id: "BRL" },
      ],
      payer: { email: params.payerEmail },
      external_reference: params.externalReference,
      ...(back
        ? { back_urls: { success: back, pending: back, failure: back }, auto_return: "approved" }
        : {}),
      ...(notification ? { notification_url: notification } : {}),
      payment_methods: {
        installments: 1,
        ...(params.onlyPix
          ? {
              excluded_payment_types: [
                { id: "credit_card" },
                { id: "debit_card" },
                { id: "prepaid_card" },
                { id: "ticket" },
                { id: "atm" },
              ],
            }
          : {}),
      },
    },
  });
}

// --------------------------- Webhook ---------------------------

/**
 * Confere o cabeçalho `x-signature` do Mercado Pago:
 * `ts=<epoch>,v1=<hmac>` com HMAC-SHA256 sobre
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 *
 * Sem MP_WEBHOOK_SECRET o hub recusa tudo — a não ser que
 * ALLOW_UNSIGNED_WEBHOOKS=true (só desenvolvimento local).
 */
export function verifyMpSignature(params: {
  signatureHeader: string | null;
  requestId: string | null;
  dataId: string | null;
  secret?: string;
}): boolean {
  const secret = params.secret ?? process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.ALLOW_UNSIGNED_WEBHOOKS === "true") {
      logger.warn("MP_WEBHOOK_SECRET ausente — assinatura não verificada (modo desenvolvimento)");
      return true;
    }
    logger.error("MP_WEBHOOK_SECRET ausente — webhook recusado");
    return false;
  }
  if (!params.signatureHeader || !params.dataId) return false;

  const parts = Object.fromEntries(
    params.signatureHeader.split(",").map((piece) => {
      const [key, ...rest] = piece.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const ts = parts.ts;
  const received = parts.v1;
  if (!ts || !received) return false;

  const manifest = `id:${params.dataId.toLowerCase()};request-id:${params.requestId ?? ""};ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
