import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyMpSignature } from "@/lib/mp";
import { ingestPayment, ingestPreapproval } from "@/lib/ingest";
import { attemptDelivery, retryDue } from "@/lib/delivery";

/**
 * Única URL cadastrada no Mercado Pago.
 *
 *  1. Confere a assinatura (x-signature) — sem MP_WEBHOOK_SECRET recusa tudo.
 *  2. Nunca confia no corpo: o MP manda só o id; valor e status vêm de uma
 *     consulta autenticada à API deles.
 *  3. Grava o aviso bruto (Event), identifica o app pelo prefixo do
 *     external_reference e cria a entrega.
 *  4. Responde 200 (ou 500 se falhar, para o MP reenviar) e só depois tenta entregar ao app (after) — erro aqui faria
 *     o MP reenviar por horas.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Algumas notificações chegam só com query string.
  }

  const type = ((body.type ?? body.topic ?? url.searchParams.get("type") ?? url.searchParams.get("topic")) as
    | string
    | null) ?? null;
  const dataId =
    ((body.data as { id?: string | number } | undefined)?.id?.toString() ??
      url.searchParams.get("data.id") ??
      (body.id as string | number | undefined)?.toString() ??
      url.searchParams.get("id")) ||
    null;
  const requestId = request.headers.get("x-request-id");

  const valid = verifyMpSignature({
    signatureHeader: request.headers.get("x-signature"),
    requestId,
    dataId,
  });
  if (!valid) {
    logger.warn("Webhook do Mercado Pago com assinatura inválida", { type, dataId });
    return NextResponse.json({ error: "assinatura inválida" }, { status: 401 });
  }

  if (!dataId || !type) return NextResponse.json({ ok: true, ignored: "sem id ou tipo" });

  const event = await prisma.event.create({
    data: { mpType: type, mpResourceId: dataId, requestId, rawBody: body as object },
    select: { id: true },
  });

  let deliveryIds: string[] = [];
  try {
    if (type === "payment") {
      deliveryIds = await ingestPayment(dataId);
    } else if (type === "subscription_preapproval" || type === "preapproval") {
      deliveryIds = await ingestPreapproval(dataId);
    }
    await prisma.event.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Falha ao processar webhook do Mercado Pago", { type, dataId, error: message });
    await prisma.event
      .update({ where: { id: event.id }, data: { error: message.slice(0, 500) } })
      .catch(() => undefined);
    // 500 faz o MP reenviar (por um tempo limitado): o aviso já está salvo em Event.
    return NextResponse.json({ error: "falha ao processar" }, { status: 500 });
  }

  after(async () => {
    for (const id of deliveryIds) await attemptDelivery(id);
    // Aproveita a chamada para reenviar o que ficou pendente de antes.
    await retryDue();
  });

  return NextResponse.json({ ok: true });
}
