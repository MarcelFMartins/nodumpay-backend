import { NextResponse } from "next/server";
import { listPayments } from "@/lib/admin";
import { adminRoute } from "@/lib/admin-route";

export const dynamic = "force-dynamic";

/** Últimos 100 pagamentos. Filtros: ?app=<id>|none&status=<status do MP>. */
export const GET = adminRoute(async (request) => {
  const params = new URL(request.url).searchParams;
  return NextResponse.json(await listPayments({ app: params.get("app"), status: params.get("status") }));
});
