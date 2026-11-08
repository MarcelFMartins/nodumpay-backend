import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requeueDelivery } from "@/lib/delivery";
import { adminRoute } from "@/lib/admin-route";

type Context = { params: Promise<{ id: string }> };

/** Reenvio manual: zera o contador e tenta já. Devolve o estado depois da tentativa. */
export const POST = adminRoute<Context>(async (_request, { params }) => {
  const { id } = await params;
  const exists = await prisma.delivery.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "entrega não encontrada" }, { status: 404 });
  await requeueDelivery(id);
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    select: { id: true, status: true, attempts: true, lastError: true, lastStatusCode: true },
  });
  return NextResponse.json(delivery);
});
