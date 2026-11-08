import { NextResponse } from "next/server";
import { listDeliveries } from "@/lib/admin";
import { adminRoute } from "@/lib/admin-route";

export const dynamic = "force-dynamic";

/** Últimas 100 entregas. Filtro: ?status=PENDING|DELIVERED|FAILED. */
export const GET = adminRoute(async (request) => {
  const status = new URL(request.url).searchParams.get("status");
  return NextResponse.json(await listDeliveries({ status }));
});
