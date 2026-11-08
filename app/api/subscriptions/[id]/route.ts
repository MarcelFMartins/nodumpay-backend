import { NextResponse } from "next/server";
import { authenticateApp } from "@/lib/apps";
import { loadOwnedPreapproval, toSubscription } from "@/lib/subscriptions";

/** Consulta uma assinatura do próprio app (id do Mercado Pago). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await authenticateApp(request);
  if (!app) return NextResponse.json({ error: "não autorizado" }, { status: 401 });

  const loaded = await loadOwnedPreapproval(app, (await params).id);
  if (!loaded.ok) return loaded.response;
  return NextResponse.json(toSubscription(loaded.preapproval));
}
