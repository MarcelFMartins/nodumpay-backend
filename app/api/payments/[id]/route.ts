import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApp } from "@/lib/apps";

/** Consulta de um pagamento do próprio app (id do Mercado Pago). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await authenticateApp(request);
  if (!app) return NextResponse.json({ error: "não autorizado" }, { status: 401 });

  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { mpPaymentId: id } });
  // 404 também para pagamento de outro app: não revela que existe.
  if (!payment || payment.appId !== app.id) {
    return NextResponse.json({ error: "não encontrado" }, { status: 404 });
  }

  return NextResponse.json({
    paymentId: payment.mpPaymentId,
    reference: payment.reference,
    status: payment.status,
    amountCents: payment.amountCents,
    method: payment.method,
    approvedAt: payment.approvedAt,
    createdAt: payment.createdAt,
  });
}
