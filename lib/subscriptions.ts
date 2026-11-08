import type { App } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseReference } from "@/lib/reference";
import { getPreapproval, MercadoPagoError, type PreapprovalResponse } from "@/lib/mp";

/**
 * O app só enxerga assinaturas que são dele:
 *  - referência com o prefixo do app ("barber:<id>");
 *  - referência antiga sem prefixo (ou com prefixo que não é de nenhum app),
 *    se o app é o marcado como legado.
 */
export async function ownsReference(app: App, raw: string | null | undefined): Promise<boolean> {
  const parsed = parseReference(raw);
  if (!parsed) return false;
  if (parsed.slug === app.slug) return true;
  if (!app.legacyMatch) return false;
  if (!parsed.slug) return true;
  const other = await prisma.app.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
  return !other;
}

/** Formato que o hub devolve aos apps (sem detalhes internos do MP). */
export function toSubscription(preapproval: PreapprovalResponse) {
  const parsed = parseReference(preapproval.external_reference);
  return {
    preapprovalId: preapproval.id,
    status: preapproval.status,
    reference: parsed?.reference ?? null,
    checkoutUrl: preapproval.init_point ?? null,
    payerEmail: preapproval.payer_email ?? null,
    nextPaymentDate: preapproval.next_payment_date ?? null,
    amountCents:
      preapproval.auto_recurring?.transaction_amount !== undefined
        ? Math.round(preapproval.auto_recurring.transaction_amount * 100)
        : null,
    frequencyMonths: preapproval.auto_recurring?.frequency ?? null,
  };
}

/**
 * Busca a assinatura no MP e confere o dono. Assinatura de outro app,
 * ou que não existe, vira 404 (não revela que existe).
 */
export async function loadOwnedPreapproval(
  app: App,
  id: string
): Promise<{ ok: true; preapproval: PreapprovalResponse } | { ok: false; response: Response }> {
  try {
    const preapproval = await getPreapproval(id);
    if (await ownsReference(app, preapproval.external_reference)) return { ok: true, preapproval };
  } catch (error) {
    if (!(error instanceof MercadoPagoError && error.status && error.status < 500)) {
      return { ok: false, response: mpFailure(error) };
    }
  }
  return { ok: false, response: NextResponse.json({ error: "não encontrado" }, { status: 404 }) };
}

export function mpFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "erro no Mercado Pago";
  const status = error instanceof MercadoPagoError && error.status && error.status < 500 ? 422 : 502;
  return NextResponse.json({ error: message }, { status });
}
