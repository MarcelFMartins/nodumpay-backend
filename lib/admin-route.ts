import { NextResponse } from "next/server";
import { isAdminRequest, type AdminResult } from "@/lib/admin";

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/** Envolve uma rota /api/admin/*: exige ADMIN_API_TOKEN e nunca é cacheada. */
export function adminRoute<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    if (!isAdminRequest(request)) return NextResponse.json({ error: "não autorizado" }, { status: 401 });
    const response = await handler(request, context);
    response.headers.set("cache-control", "no-store");
    return response;
  };
}

export function fromResult<T>(result: AdminResult<T>, okStatus = 200): Response {
  return result.ok
    ? NextResponse.json(result.data, { status: okStatus })
    : NextResponse.json({ error: result.error }, { status: result.status });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
