/**
 * Consultas e ações do painel. O painel (frontend na Vercel) chama estas
 * funções pelas rotas /api/admin/*, sempre do servidor, com ADMIN_API_TOKEN.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { systemHealth } from "@/lib/health";
import { generateCredentials } from "@/lib/apps";
import { SLUG_PATTERN } from "@/lib/reference";

// ---------------------------------------------------------------- auth

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** `Authorization: Bearer <ADMIN_API_TOKEN>`. Sem token configurado, ninguém entra. */
export function isAdminRequest(request: Request): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected || expected.length < 32) return false;
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqual(digest(match[1].trim()), digest(expected));
}

// ---------------------------------------------------------------- visão geral

/** Início do mês e dos últimos 30 dias no horário de Brasília (UTC-3, sem horário de verão). */
function ranges() {
  const brt = new Date(Date.now() - 3 * 3_600_000);
  const monthStart = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1, 3));
  const dayStart = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), 3));
  const since = new Date(dayStart.getTime() - 29 * 86_400_000);
  return { monthStart, since, dayStart };
}

export async function overview() {
  const { monthStart, since, dayStart } = ranges();
  const approved = { in: ["approved", "authorized"] };

  const [health, month, failed, unrouted, byApp, daily, recentErrors, apps] = await Promise.all([
    systemHealth(),
    prisma.payment.aggregate({
      where: { status: approved, createdAt: { gte: monthStart } },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.payment.count({ where: { status: { in: ["rejected", "cancelled"] }, createdAt: { gte: monthStart } } }),
    prisma.payment.count({ where: { appId: null } }),
    prisma.payment.groupBy({
      by: ["appId"],
      where: { status: approved, createdAt: { gte: monthStart } },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.$queryRaw<{ d: string; cents: number; n: number }[]>`
      SELECT to_char(date_trunc('day', (COALESCE("approvedAt","createdAt") AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS d,
             SUM("amountCents")::int AS cents, COUNT(*)::int AS n
      FROM "Payment"
      WHERE status IN ('approved','authorized') AND COALESCE("approvedAt","createdAt") >= ${since}
      GROUP BY 1 ORDER BY 1`,
    prisma.event.findMany({
      where: { error: { not: null } },
      orderBy: { receivedAt: "desc" },
      take: 5,
      select: { id: true, receivedAt: true, mpType: true, mpResourceId: true, error: true },
    }),
    prisma.app.findMany({ select: { id: true, name: true } }),
  ]);

  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const totalCents = month._sum.amountCents ?? 0;

  // 30 colunas, uma por dia (horário de Brasília), mesmo sem venda.
  const series = Array.from({ length: 30 }, (_, i) => {
    const key = new Date(dayStart.getTime() - (29 - i) * 86_400_000 - 3 * 3_600_000).toISOString().slice(0, 10);
    const row = daily.find((r) => r.d === key);
    return { key, cents: row?.cents ?? 0, n: row?.n ?? 0 };
  });

  return {
    health,
    month: {
      totalCents,
      approvedCount: month._count,
      ticketCents: month._count ? Math.round(totalCents / month._count) : 0,
      failedCount: failed,
    },
    unroutedCount: unrouted,
    byApp: byApp.map((r) => ({
      appId: r.appId,
      appName: r.appId ? (appName.get(r.appId) ?? r.appId) : null,
      approvedCount: r._count,
      totalCents: r._sum.amountCents ?? 0,
    })),
    series,
    recentErrors,
  };
}

// ---------------------------------------------------------------- listas

export async function listPayments(filter: { app?: string | null; status?: string | null }) {
  const [payments, apps] = await Promise.all([
    prisma.payment.findMany({
      where: {
        ...(filter.app === "none" ? { appId: null } : filter.app ? { appId: filter.app } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        reference: true,
        rawReference: true,
        amountCents: true,
        status: true,
        method: true,
        mpPaymentId: true,
        app: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.app.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { payments, apps };
}

const DELIVERY_STATUS = z.enum(["PENDING", "DELIVERED", "FAILED"]);

export async function listDeliveries(filter: { status?: string | null }) {
  const status = DELIVERY_STATUS.safeParse(filter.status);
  const deliveries = await prisma.delivery.findMany({
    where: status.success ? { status: status.data } : {},
    select: {
      id: true,
      createdAt: true,
      eventType: true,
      status: true,
      attempts: true,
      deliveredAt: true,
      nextAttemptAt: true,
      lastError: true,
      lastStatusCode: true,
      app: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { deliveries };
}

export async function listApps() {
  const apps = await prisma.app.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      webhookUrl: true,
      active: true,
      legacyMatch: true,
      createdAt: true,
      _count: { select: { payments: true, deliveries: true } },
    },
  });
  return {
    apps: apps.map(({ _count, ...app }) => ({ ...app, paymentsCount: _count.payments, deliveriesCount: _count.deliveries })),
  };
}

// ---------------------------------------------------------------- ações

export type AdminResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Mostradas uma única vez: depois só existe o hash da chave. */
export interface Credentials {
  appId: string;
  appName: string;
  apiKey: string;
  signingSecret: string;
}

const webhookUrlSchema = z
  .url("URL do webhook inválida")
  .refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", "O webhook do app precisa ser HTTPS");

export const createAppSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, "slug: letras minúsculas, números e hífen (2 a 31 caracteres)"),
  name: z.string().trim().min(2, "nome: mínimo 2 caracteres").max(60),
  webhookUrl: z.string().trim().pipe(webhookUrlSchema),
  legacyMatch: z.boolean().default(false),
});

export async function createApp(input: unknown): Promise<AdminResult<Credentials>> {
  const parsed = createAppSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const exists = await prisma.app.findUnique({ where: { slug: parsed.data.slug } });
  if (exists) return { ok: false, status: 409, error: "Já existe um app com esse slug" };

  const { apiKey, apiKeyHash, signingSecret } = generateCredentials();
  const app = await prisma.$transaction(async (tx) => {
    if (parsed.data.legacyMatch) await tx.app.updateMany({ where: { legacyMatch: true }, data: { legacyMatch: false } });
    return tx.app.create({ data: { ...parsed.data, apiKeyHash, signingSecret } });
  });
  return { ok: true, data: { appId: app.id, appName: app.name, apiKey, signingSecret } };
}

export const updateAppSchema = z.object({
  webhookUrl: z.string().trim().pipe(webhookUrlSchema),
  active: z.boolean(),
  legacyMatch: z.boolean(),
});

export async function updateApp(id: string, input: unknown): Promise<AdminResult<{ id: string }>> {
  const parsed = updateAppSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const app = await prisma.app.findUnique({ where: { id } });
  if (!app) return { ok: false, status: 404, error: "App não encontrado" };

  await prisma.$transaction(async (tx) => {
    if (parsed.data.legacyMatch) {
      await tx.app.updateMany({ where: { legacyMatch: true, NOT: { id } }, data: { legacyMatch: false } });
    }
    await tx.app.update({ where: { id }, data: parsed.data });
  });
  return { ok: true, data: { id } };
}

export async function rotateCredentials(id: string): Promise<AdminResult<Credentials>> {
  const app = await prisma.app.findUnique({ where: { id } });
  if (!app) return { ok: false, status: 404, error: "App não encontrado" };

  const { apiKey, apiKeyHash, signingSecret } = generateCredentials();
  await prisma.app.update({ where: { id }, data: { apiKeyHash, signingSecret } });
  return { ok: true, data: { appId: app.id, appName: app.name, apiKey, signingSecret } };
}
