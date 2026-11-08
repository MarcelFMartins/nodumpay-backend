import { NextResponse } from "next/server";
import { authenticateApp } from "@/lib/apps";
import { cancelPreapproval } from "@/lib/mp";
import { loadOwnedPreapproval, mpFailure, toSubscription } from "@/lib/subscriptions";

/**
 * Desliga a renovação automática. Idempotente: cancelar uma assinatura já
 * cancelada devolve 200 com o status atual.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await authenticateApp(request);
  if (!app) return NextResponse.json({ error: "não autorizado" }, { status: 401 });

  const loaded = await loadOwnedPreapproval(app, (await params).id);
  if (!loaded.ok) return loaded.response;
  if (loaded.preapproval.status === "cancelled") return NextResponse.json(toSubscription(loaded.preapproval));

  try {
    return NextResponse.json(toSubscription(await cancelPreapproval(loaded.preapproval.id)));
  } catch (error) {
    return mpFailure(error);
  }
}
