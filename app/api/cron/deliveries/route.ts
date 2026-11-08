import { NextResponse } from "next/server";
import { retryDue } from "@/lib/delivery";

/**
 * Reenvia avisos pendentes sob demanda. O hub já faz isso sozinho
 * (ver instrumentation.ts); esta rota serve a um agendador externo opcional,
 * com `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }
  return NextResponse.json(await retryDue(100));
}
