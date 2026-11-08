import { NextResponse } from "next/server";
import { createApp, listApps } from "@/lib/admin";
import { adminRoute, fromResult, readJson } from "@/lib/admin-route";

export const dynamic = "force-dynamic";

export const GET = adminRoute(async () => NextResponse.json(await listApps()));

/** Body: { slug, name, webhookUrl, legacyMatch? }. Devolve as credenciais uma única vez. */
export const POST = adminRoute(async (request) => fromResult(await createApp(await readJson(request)), 201));
