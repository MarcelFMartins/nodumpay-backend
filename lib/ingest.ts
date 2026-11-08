import type { App } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getPayment, getPreapproval } from "@/lib/mp";
import { parseReference } from "@/lib/reference";
import { eventForPayment, eventForPreapproval, type HubEvent } from "@/lib/events";

/**
 * Descobre o app dono de uma referência.
 *  - com prefixo ("studio:abc") → app com esse slug;
 *  - sem prefixo (cobranças antigas) → o app marcado como `legacyMatch`.
 */
async function resolveApp(raw: string | null | undefined) {
  const parsed = parseReference(raw);
  if (!parsed) return { app: null as App | null, reference: null as string | null };

  if (parsed.slug) {
    const app = await prisma.app.findUnique({ where: { slug: parsed.slug } });
    if (app && app.active) return { app, reference: parsed.reference };
    // O prefixo parece um slug mas não existe: pode ser uma referência
    // antiga que por acaso contém ":" — cai para o app legado.
  }

  const legacy = await prisma.app.findFirst({ where: { legacyMatch: true, active: true } });
  return { app: legacy, reference: raw ?? null };
}

async function enqueue(params: {
  app: App;
  event: HubEvent;
  resourceId: string;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  const dedupeKey = `${params.event}:${params.resourceId}`;
  try {
    const created = await prisma.delivery.create({
      data: {
        appId: params.app.id,
        eventType: params.event,
        dedupeKey,
        payload: { event: params.event, app: params.app.slug, ...params.payload } as object,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    // P2002 = já existe uma entrega para este fato: aviso duplicado do MP.
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

/** Processa um aviso de pagamento. Devolve os ids de entregas novas. */
export async function ingestPayment(paymentId: string): Promise<string[]> {
  const payment = await getPayment(paymentId);

  let rawReference = payment.external_reference ?? null;
  if (!rawReference && payment.preapproval_id) {
    // Cobrança recorrente: a referência mora na assinatura, não no pagamento.
    rawReference = (await getPreapproval(payment.preapproval_id)).external_reference ?? null;
  }

  const { app, reference } = await resolveApp(rawReference);
  const amountCents = Math.round(payment.transaction_amount * 100);
  const mpPaymentId = String(payment.id);

  await prisma.payment.upsert({
    where: { mpPaymentId },
    create: {
      mpPaymentId,
      appId: app?.id ?? null,
      reference,
      rawReference,
      status: payment.status,
      amountCents,
      method: payment.payment_method_id ?? null,
      preapprovalId: payment.preapproval_id ?? null,
      approvedAt: payment.date_approved ? new Date(payment.date_approved) : null,
    },
    update: {
      appId: app?.id ?? null,
      reference,
      rawReference,
      status: payment.status,
      amountCents,
      method: payment.payment_method_id ?? null,
      preapprovalId: payment.preapproval_id ?? null,
      approvedAt: payment.date_approved ? new Date(payment.date_approved) : null,
    },
  });

  if (!app) {
    logger.warn("Pagamento sem app identificável", { paymentId: mpPaymentId, rawReference });
    return [];
  }

  const event = eventForPayment(payment.status);
  if (!event) return [];

  const id = await enqueue({
    app,
    event,
    resourceId: mpPaymentId,
    payload: {
      reference,
      rawReference,
      paymentId: mpPaymentId,
      preapprovalId: payment.preapproval_id ?? null,
      status: payment.status,
      amountCents,
      method: payment.payment_method_id ?? null,
      occurredAt: new Date().toISOString(),
    },
  });
  return id ? [id] : [];
}

/** Processa um aviso de assinatura recorrente (pausada/cancelada). */
export async function ingestPreapproval(preapprovalId: string): Promise<string[]> {
  const preapproval = await getPreapproval(preapprovalId);
  const event = eventForPreapproval(preapproval.status);
  if (!event) return [];

  const { app, reference } = await resolveApp(preapproval.external_reference);
  if (!app) {
    logger.warn("Assinatura sem app identificável", { preapprovalId });
    return [];
  }

  const id = await enqueue({
    app,
    event,
    resourceId: preapprovalId,
    payload: {
      reference,
      rawReference: preapproval.external_reference ?? null,
      paymentId: null,
      preapprovalId,
      status: preapproval.status,
      amountCents: null,
      method: null,
      occurredAt: new Date().toISOString(),
    },
  });
  return id ? [id] : [];
}
