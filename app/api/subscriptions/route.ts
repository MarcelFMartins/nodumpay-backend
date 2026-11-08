import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateApp } from "@/lib/apps";
import { buildReference } from "@/lib/reference";
import { createPreapproval } from "@/lib/mp";
import { mpFailure, toSubscription } from "@/lib/subscriptions";

const schema = z.object({
  /** O id do seu lado (ex.: id da barbearia). O hub põe o prefixo do app. */
  reference: z.string().min(1).max(120),
  /** Texto que o cliente vê no Mercado Pago e na fatura. */
  reason: z.string().min(1).max(250),
  amountCents: z.number().int().positive().max(100_000_000),
  payerEmail: z.email(),
  /** De quantos em quantos meses cobra (1, 3, 6, 12). */
  frequencyMonths: z.number().int().min(1).max(12).default(1),
  backUrl: z.url().optional(),
});

/**
 * Assinatura recorrente no cartão. Devolve o link para o cliente cadastrar
 * o cartão; a partir daí cada cobrança mensal chega como `payment.approved`
 * / `payment.failed` no webhook do app, com o mesmo `reference`.
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

  try {
    const preapproval = await createPreapproval({
      reason: input.reason,
      payerEmail: input.payerEmail,
      amountBRL: input.amountCents / 100,
      frequencyMonths: input.frequencyMonths,
      externalReference: buildReference(app.slug, input.reference),
      backUrl: input.backUrl,
      // Cada pedido é uma assinatura nova (troca de ciclo, novo cartão).
      idempotencyKey: `preapproval-${app.slug}-${input.reference}-${Date.now()}`,
    });
    return NextResponse.json(toSubscription(preapproval), { status: 201 });
  } catch (error) {
    return mpFailure(error);
  }
}
