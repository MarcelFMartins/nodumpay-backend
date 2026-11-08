import { NextResponse } from "next/server";

/** Raiz da API: só identifica o serviço. O painel fica no frontend. */
export function GET() {
  return NextResponse.json({ service: "nodumpay-backend", health: "/api/health" });
}
