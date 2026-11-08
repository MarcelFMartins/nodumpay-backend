import { NextResponse } from "next/server";
import { overview } from "@/lib/admin";
import { adminRoute } from "@/lib/admin-route";

export const dynamic = "force-dynamic";

/** KPIs do mês, série de 30 dias, saúde do sistema e erros recentes. */
export const GET = adminRoute(async () => NextResponse.json(await overview()));
