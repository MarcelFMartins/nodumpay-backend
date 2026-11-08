import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** Para monitor de disponibilidade: 200 se o banco responde. Sem dados sensíveis. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
