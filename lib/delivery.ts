import type { Delivery } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { signPayload } from "@/lib/signing";

/** Espera entre tentativas: 1 min, 5 min, 30 min, 2 h, 12 h. Depois disso, FAILED. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Reserva a entrega por 2 min para duas execuções não enviarem a mesma. */
const LEASE_MS = 2 * 60_000;

export function nextDelay(attemptsDone: number): number | null {
  return RETRY_DELAYS_MS[attemptsDone - 1] ?? null;
}

/**
 * Tenta entregar uma entrega ao app de origem. Devolve true se o app
 * respondeu 2xx. Nunca lança: o resultado fica gravado na própria linha.
 */
export async function attemptDelivery(deliveryId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.delivery.updateMany({
    where: { id: deliveryId, status: "PENDING", nextAttemptAt: { lte: now } },
    data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) return false;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { app: true },
  });
  if (!delivery) return false;

  const body = JSON.stringify({ ...(delivery.payload as object), deliveryId: delivery.id });
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(delivery.app.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nodum-signature": signPayload(delivery.app.signingSecret, body),
        "x-nodum-event": delivery.eventType,
        "x-nodum-delivery": delivery.id,
      },
      body,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    statusCode = response.status;
    if (!response.ok) error = `o app respondeu ${response.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const attempts = delivery.attempts + 1;
  if (!error) {
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "DELIVERED", attempts, deliveredAt: new Date(), lastStatusCode: statusCode, lastError: null },
    });
    return true;
  }

  const delay = nextDelay(attempts);
  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
      ...(delay === null
        ? { status: "FAILED" }
        : { nextAttemptAt: new Date(Date.now() + delay) }),
    },
  });
  logger.warn("Entrega ao app falhou", {
    deliveryId: delivery.id,
    app: delivery.app.slug,
    attempts,
    error,
    final: delay === null,
  });
  return false;
}

/** Reenvia o que está pendente e vencido. Chamada pelo cron e após cada webhook. */
export async function retryDue(limit = 25): Promise<{ tried: number; delivered: number }> {
  const due: Pick<Delivery, "id">[] = await prisma.delivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let delivered = 0;
  for (const { id } of due) {
    if (await attemptDelivery(id)) delivered += 1;
  }
  return { tried: due.length, delivered };
}

/** Reenvio manual (painel): zera o contador e tenta já. */
export async function requeueDelivery(deliveryId: string): Promise<void> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  await attemptDelivery(deliveryId);
}
