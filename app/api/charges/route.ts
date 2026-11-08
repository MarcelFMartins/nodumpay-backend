import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticateApp } from "@/lib/apps";
import { buildReference } from "@/lib/reference";
import { createPreference, MercadoPagoError } from "@/lib/mp";

const schema = z.object({
  /** O id do seu lado (ex.: id da barbearia). O hub põe o prefixo do app. */
  reference: z.string().min(1).max(120),
  title: z.string().min(1).max(250),
  amountCents: z.number().int().positive().max(100_000_000),
  payerEmail: z.email(),
  onlyPix: z.boolean().optional(),
  backUrl: z.url().optional(),
  /** Muda a chave de idempotência (ex.: ciclo + preço) para permitir nova cobrança. */
  idempotencySuffix: z.string().max(80).optional(),
});

/**
 * Os apps pedem a cobrança ao hub; só o hub fala com o Mercado Pago.
 * Autenticação: `Authorization: Bearer <apiKey do app>`.
 */
export async function POST(request: Request) {
  const app = await authenticateApp(request);
  if (!app) return NextResponse.json({ error: "não autorizado" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "dados inválidos", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  const notificationUrl = process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/$/, "")}/api/webhooks/mercadopago`
    : undefined;

  try {
    const preference = await createPreference({
      title: input.title,
      amountBRL: input.amountCents / 100,
      payerEmail: input.payerEmail,
      externalReference: buildReference(app.slug, input.reference),
      idempotencyKey: `pref-${app.slug}-${input.reference}-${input.amountCents}${input.idempotencySuffix ? `-${input.idempotencySuffix}` : ""}`,
      onlyPix: input.onlyPix,
      backUrl: input.backUrl,
      notificationUrl,
    });

    await prisma.charge.upsert({
      where: { preferenceId: preference.id },
      create: {
        appId: app.id,
        reference: input.reference,
        preferenceId: preference.id,
        title: input.title,
        amountCents: input.amountCents,
        checkoutUrl: preference.init_point,
      },
      update: {},
    });

    return NextResponse.json({ preferenceId: preference.id, checkoutUrl: preference.init_point });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro ao criar cobrança";
    const status = error instanceof MercadoPagoError && error.status && error.status < 500 ? 422 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
