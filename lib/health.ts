import { prisma } from "@/lib/prisma";

export type Situation = "ok" | "atencao" | "erro";
export interface HealthItem {
  id: string;
  label: string;
  situation: Situation;
  detail: string;
}

/** Mesma ideia da tela "Saúde do sistema" do Studio: o que falta, em português. */
export async function systemHealth(): Promise<HealthItem[]> {
  const items: HealthItem[] = [];

  try {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    items.push({ id: "db", label: "Banco de dados", situation: "ok", detail: `respondeu em ${Date.now() - started} ms` });
  } catch {
    items.push({ id: "db", label: "Banco de dados", situation: "erro", detail: "não respondeu — confira DATABASE_URL" });
  }

  items.push(
    process.env.MP_ACCESS_TOKEN
      ? { id: "mp", label: "Mercado Pago (API)", situation: "ok", detail: "MP_ACCESS_TOKEN presente" }
      : { id: "mp", label: "Mercado Pago (API)", situation: "erro", detail: "MP_ACCESS_TOKEN ausente — não dá para consultar nem criar cobrança" }
  );
  items.push(
    process.env.MP_WEBHOOK_SECRET
      ? { id: "mp-secret", label: "Assinatura do webhook", situation: "ok", detail: "MP_WEBHOOK_SECRET presente" }
      : { id: "mp-secret", label: "Assinatura do webhook", situation: "erro", detail: "MP_WEBHOOK_SECRET ausente — o hub recusa todo webhook" }
  );

  const appUrl = process.env.APP_URL;
  items.push(
    appUrl?.startsWith("https://")
      ? { id: "url", label: "Endereço público da API (APP_URL)", situation: "ok", detail: appUrl }
      : { id: "url", label: "Endereço público da API (APP_URL)", situation: "erro", detail: "defina APP_URL com https:// — sem isso as cobranças saem sem aviso" }
  );
  const adminToken = process.env.ADMIN_API_TOKEN;
  items.push(
    adminToken && adminToken.length >= 32
      ? { id: "admin", label: "Acesso do painel (ADMIN_API_TOKEN)", situation: "ok", detail: "configurado" }
      : { id: "admin", label: "Acesso do painel (ADMIN_API_TOKEN)", situation: "erro", detail: "ausente ou curto (mín. 32) — o painel não consegue ler o hub" }
  );
  const retrySeconds = Number(process.env.DELIVERY_RETRY_INTERVAL_SECONDS ?? 60);
  items.push(
    retrySeconds > 0
      ? { id: "cron", label: "Reenvio automático", situation: "ok", detail: `a cada ${retrySeconds} s, dentro do próprio hub` }
      : process.env.CRON_SECRET
        ? { id: "cron", label: "Reenvio automático", situation: "ok", detail: "desligado no hub; agendador externo via /api/cron/deliveries" }
        : { id: "cron", label: "Reenvio automático", situation: "atencao", detail: "desligado (DELIVERY_RETRY_INTERVAL_SECONDS=0) e sem CRON_SECRET — entregas só saem a cada webhook" }
  );

  try {
    const [apps, pending, failed] = await Promise.all([
      prisma.app.count({ where: { active: true } }),
      prisma.delivery.count({ where: { status: "PENDING" } }),
      prisma.delivery.count({ where: { status: "FAILED" } }),
    ]);
    items.push(
      apps > 0
        ? { id: "apps", label: "Apps ligados", situation: "ok", detail: `${apps} ativo(s)` }
        : { id: "apps", label: "Apps ligados", situation: "atencao", detail: "nenhum app cadastrado — cadastre em Apps" }
    );
    items.push(
      failed > 0
        ? { id: "deliveries", label: "Entregas aos apps", situation: "erro", detail: `${failed} falharam de vez · ${pending} pendentes` }
        : pending > 0
          ? { id: "deliveries", label: "Entregas aos apps", situation: "atencao", detail: `${pending} aguardando nova tentativa` }
          : { id: "deliveries", label: "Entregas aos apps", situation: "ok", detail: "nada pendente" }
    );
  } catch {
    // banco fora do ar: o primeiro item já avisou.
  }

  return items;
}
