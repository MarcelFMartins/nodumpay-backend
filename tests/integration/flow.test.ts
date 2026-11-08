/**
 * Fluxo completo contra um Postgres real e um Mercado Pago falso:
 *   cobrança → webhook assinado → pagamento gravado → aviso assinado ao app → retry.
 *
 * Roda só com TEST_DATABASE_URL (um banco vazio e descartável):
 *   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/nodumpay_test npm test
 */
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DB = process.env.TEST_DATABASE_URL;
const pendingAfter: Promise<unknown>[] = [];

vi.mock("next/server", async (original) => {
  const mod = await original<typeof import("next/server")>();
  return { ...mod, after: (task: () => unknown) => void pendingAfter.push(Promise.resolve(task())) };
});

const MP_SECRET = "mp-webhook-secret";
const ADMIN_TOKEN = "admin-token-de-teste-com-mais-de-32-caracteres";
const mpPayments: Record<string, object> = {};
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let appStatus = 200;
let mpServer: http.Server;
let appServer: http.Server;
let appUrl = "";

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function mpSignature(dataId: string, requestId: string) {
  const ts = String(Date.now());
  const v1 = createHmac("sha256", MP_SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

async function webhook(dataId: string, type = "payment", sign = true) {
  const { POST } = await import("@/app/api/webhooks/mercadopago/route");
  const requestId = `req-${Math.random()}`;
  const response = await POST(
    new Request(`http://hub/api/webhooks/mercadopago?data.id=${dataId}&type=${type}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sign ? { "x-signature": mpSignature(dataId, requestId), "x-request-id": requestId } : {}),
      },
      body: JSON.stringify({ type, data: { id: dataId } }),
    })
  );
  await Promise.all(pendingAfter.splice(0));
  return response;
}

describe.skipIf(!DB)("fluxo do hub (Postgres real)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let signingSecret = "";
  let apiKey = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    // Trava de segurança: só limpa tabelas de um banco que se declara de teste.
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error("TEST_DATABASE_URL precisa apontar para um banco com 'test' no nome");
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

    mpServer = await listen((req, res) => {
      const match = req.url?.match(/\/v1\/payments\/(\d+)/);
      if (req.method === "POST" && req.url === "/checkout/preferences") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "pref-1", init_point: "https://mp.test/checkout/pref-1" }));
      } else if (match && mpPayments[match[1]]) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(mpPayments[match[1]]));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    appServer = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = appStatus;
        res.end("{}");
      });
    });
    appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/hook`;
    process.env.MP_API_URL = `http://127.0.0.1:${(mpServer.address() as AddressInfo).port}`;
    process.env.MP_ACCESS_TOKEN = "TEST-token";
    process.env.MP_WEBHOOK_SECRET = MP_SECRET;
    process.env.APP_URL = "https://pay.exemplo.com";
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;

    prisma = (await import("@/lib/prisma")).prisma;
    await prisma.$executeRawUnsafe('TRUNCATE "Delivery","Charge","Payment","Event","App" RESTART IDENTITY CASCADE');
    const { generateCredentials } = await import("@/lib/apps");
    const creds = generateCredentials();
    apiKey = creds.apiKey;
    signingSecret = creds.signingSecret;
    await prisma.app.create({
      data: { slug: "studio", name: "Studio", webhookUrl: appUrl, apiKeyHash: creds.apiKeyHash, signingSecret, legacyMatch: true },
    });
    const barber = generateCredentials();
    await prisma.app.create({
      data: { slug: "barber", name: "Barber", webhookUrl: appUrl, apiKeyHash: barber.apiKeyHash, signingSecret: barber.signingSecret },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    mpServer?.close();
    appServer?.close();
  });

  beforeEach(() => {
    received.length = 0;
    appStatus = 200;
  });

  it("recusa webhook sem assinatura", async () => {
    expect((await webhook("900", "payment", false)).status).toBe(401);
  });

  it("cria cobrança com o prefixo do app e exige a chave", async () => {
    const { POST } = await import("@/app/api/charges/route");
    const call = (key?: string) =>
      POST(
        new Request("http://hub/api/charges", {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ reference: "shop-1", title: "Mensalidade", amountCents: 4990, payerEmail: "a@b.com" }),
        })
      );
    expect((await call()).status).toBe(401);
    expect((await call("npk_errada")).status).toBe(401);
    const ok = await call(apiKey);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ preferenceId: "pref-1", checkoutUrl: "https://mp.test/checkout/pref-1" });
    expect(await prisma.charge.count({ where: { reference: "shop-1" } })).toBe(1);
  });

  it("pagamento aprovado do Studio chega ao Studio, assinado, e não duplica", async () => {
    mpPayments["1001"] = {
      id: 1001, status: "approved", transaction_amount: 49.9, payment_method_id: "pix",
      external_reference: "studio:shop-1", date_approved: new Date().toISOString(),
    };
    expect((await webhook("1001")).status).toBe(200);
    expect(received).toHaveLength(1);

    const { verifyHubSignature } = await import("@/lib/signing");
    const { headers, body } = received[0];
    expect(verifyHubSignature({ secret: signingSecret, body, header: String(headers["x-nodum-signature"]) })).toBe(true);
    expect(headers["x-nodum-event"]).toBe("payment.approved");
    expect(JSON.parse(body)).toMatchObject({
      event: "payment.approved", app: "studio", reference: "shop-1", paymentId: "1001", amountCents: 4990, method: "pix",
    });

    // O MP reenvia o mesmo aviso: nada novo para o app.
    await webhook("1001");
    expect(received).toHaveLength(1);
    expect(await prisma.payment.count({ where: { mpPaymentId: "1001" } })).toBe(1);
    expect(await prisma.event.count({ where: { mpResourceId: "1001" } })).toBe(2);
  });

  it("separa os apps pelo prefixo", async () => {
    mpPayments["1002"] = { id: 1002, status: "approved", transaction_amount: 10, external_reference: "barber:b-9" };
    await webhook("1002");
    expect(JSON.parse(received[0].body)).toMatchObject({ app: "barber", reference: "b-9" });
    const payment = await prisma.payment.findUnique({ where: { mpPaymentId: "1002" }, include: { app: true } });
    expect(payment?.app?.slug).toBe("barber");
  });

  it("referência antiga, sem prefixo, vai para o app legado", async () => {
    mpPayments["1003"] = { id: 1003, status: "approved", transaction_amount: 20, external_reference: "clx-antigo" };
    await webhook("1003");
    expect(JSON.parse(received[0].body)).toMatchObject({ app: "studio", reference: "clx-antigo" });
  });

  it("pagamento sem referência é gravado sem app e ninguém é avisado", async () => {
    mpPayments["1004"] = { id: 1004, status: "approved", transaction_amount: 5 };
    await webhook("1004");
    expect(received).toHaveLength(0);
    expect((await prisma.payment.findUnique({ where: { mpPaymentId: "1004" } }))?.appId).toBeNull();
  });

  it("recusado vira payment.failed; pendente não avisa", async () => {
    mpPayments["1005"] = { id: 1005, status: "rejected", transaction_amount: 5, external_reference: "studio:s" };
    await webhook("1005");
    expect(JSON.parse(received[0].body).event).toBe("payment.failed");

    received.length = 0;
    mpPayments["1006"] = { id: 1006, status: "pending", transaction_amount: 5, external_reference: "studio:s" };
    await webhook("1006");
    expect(received).toHaveLength(0);
  });

  it("app fora do ar: a entrega fica pendente e o retry entrega depois", async () => {
    appStatus = 500;
    mpPayments["1007"] = { id: 1007, status: "approved", transaction_amount: 7, external_reference: "studio:s" };
    await webhook("1007");
    const delivery = await prisma.delivery.findUnique({ where: { dedupeKey: "payment.approved:1007" } });
    expect(delivery).toMatchObject({ status: "PENDING", attempts: 1, lastStatusCode: 500 });

    appStatus = 200;
    const { retryDue } = await import("@/lib/delivery");
    expect((await retryDue()).delivered).toBe(0); // ainda dentro da espera de 1 min

    await prisma.delivery.update({ where: { id: delivery!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect((await retryDue()).delivered).toBe(1);
    expect(await prisma.delivery.findUnique({ where: { id: delivery!.id } })).toMatchObject({ status: "DELIVERED", attempts: 2 });
  });

  it("depois de todas as tentativas a entrega vira FAILED", async () => {
    appStatus = 500;
    mpPayments["1008"] = { id: 1008, status: "approved", transaction_amount: 8, external_reference: "studio:s" };
    await webhook("1008");
    const { retryDue, MAX_ATTEMPTS } = await import("@/lib/delivery");
    const key = "payment.approved:1008";
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await prisma.delivery.update({ where: { dedupeKey: key }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await retryDue();
    }
    expect(await prisma.delivery.findUnique({ where: { dedupeKey: key } })).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
  });

  it("consulta de pagamento só enxerga o próprio app", async () => {
    const { GET } = await import("@/app/api/payments/[id]/route");
    const get = (id: string, key: string) =>
      GET(new Request(`http://hub/api/payments/${id}`, { headers: { authorization: `Bearer ${key}` } }), {
        params: Promise.resolve({ id }),
      });
    expect((await get("1001", apiKey)).status).toBe(200);
    expect((await get("1002", apiKey)).status).toBe(404); // é do barber
  });

  describe("API do painel (/api/admin)", () => {
    const auth = (token = ADMIN_TOKEN) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

    it("exige o ADMIN_API_TOKEN", async () => {
      const { GET } = await import("@/app/api/admin/overview/route");
      expect((await GET(new Request("http://hub/api/admin/overview"), undefined)).status).toBe(401);
      expect((await GET(new Request("http://hub/api/admin/overview", { headers: auth("errado") }), undefined)).status).toBe(401);
      expect((await GET(new Request("http://hub/api/admin/overview", { headers: auth(apiKey) }), undefined)).status).toBe(401);
    });

    it("visão geral soma os aprovados do mês e lista a saúde", async () => {
      const { GET } = await import("@/app/api/admin/overview/route");
      const res = await GET(new Request("http://hub/api/admin/overview", { headers: auth() }), undefined);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.month.approvedCount).toBeGreaterThan(0);
      expect(body.month.totalCents).toBeGreaterThan(0);
      expect(body.series).toHaveLength(30);
      expect(body.health.find((h: { id: string }) => h.id === "admin").situation).toBe("ok");
      expect(body.byApp.some((r: { appName: string }) => r.appName === "Studio")).toBe(true);
    });

    it("lista pagamentos com filtro e entregas", async () => {
      const payments = await import("@/app/api/admin/payments/route");
      const studio = await prisma.app.findUniqueOrThrow({ where: { slug: "studio" } });
      const res = await payments.GET(new Request(`http://hub/api/admin/payments?app=${studio.id}`, { headers: auth() }), undefined);
      const body = await res.json();
      expect(body.payments.length).toBeGreaterThan(0);
      expect(body.payments.every((p: { app: { id: string } }) => p.app.id === studio.id)).toBe(true);
      expect(body.apps.map((a: { name: string }) => a.name)).toEqual(["Barber", "Studio"]);

      const unrouted = await (await payments.GET(new Request("http://hub/api/admin/payments?app=none", { headers: auth() }), undefined)).json();
      expect(unrouted.payments.every((p: { app: null }) => p.app === null)).toBe(true);

      const deliveries = await import("@/app/api/admin/deliveries/route");
      const failed = await (await deliveries.GET(new Request("http://hub/api/admin/deliveries?status=FAILED", { headers: auth() }), undefined)).json();
      expect(failed.deliveries.length).toBeGreaterThan(0);
      expect(failed.deliveries.every((d: { status: string }) => d.status === "FAILED")).toBe(true);
    });

    it("reenvio manual entrega uma entrega que tinha falhado", async () => {
      const failed = await prisma.delivery.findFirstOrThrow({ where: { status: "FAILED" } });
      const { POST } = await import("@/app/api/admin/deliveries/[id]/resend/route");
      const res = await POST(new Request(`http://hub/api/admin/deliveries/${failed.id}/resend`, { method: "POST", headers: auth() }), {
        params: Promise.resolve({ id: failed.id }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: failed.id, status: "DELIVERED", attempts: 1 });
      expect(received).toHaveLength(1);
    });

    it("cadastra app, devolve credenciais uma vez, edita e gira as credenciais", async () => {
      const apps = await import("@/app/api/admin/apps/route");
      const create = (body: object) =>
        apps.POST(new Request("http://hub/api/admin/apps", { method: "POST", headers: auth(), body: JSON.stringify(body) }), undefined);

      expect((await create({ slug: "X!", name: "Ruim", webhookUrl: appUrl })).status).toBe(400);
      expect((await create({ slug: "studio", name: "Outro", webhookUrl: appUrl })).status).toBe(409);

      const res = await create({ slug: "Agenda", name: "Agenda", webhookUrl: appUrl, legacyMatch: true });
      expect(res.status).toBe(201);
      const creds = await res.json();
      expect(creds.apiKey).toMatch(/^npk_/);
      expect(creds.signingSecret).toMatch(/^whsec_/);
      // Só um app com "cobranças antigas": o Studio perdeu a marca.
      expect((await prisma.app.findUniqueOrThrow({ where: { slug: "studio" } })).legacyMatch).toBe(false);

      const list = await (await apps.GET(new Request("http://hub/api/admin/apps", { headers: auth() }), undefined)).json();
      const agenda = list.apps.find((a: { slug: string }) => a.slug === "agenda");
      expect(agenda).toMatchObject({ name: "Agenda", legacyMatch: true, paymentsCount: 0 });
      expect(agenda).not.toHaveProperty("signingSecret");
      expect(agenda).not.toHaveProperty("apiKeyHash");

      const one = await import("@/app/api/admin/apps/[id]/route");
      const patch = await one.PATCH(
        new Request(`http://hub/api/admin/apps/${agenda.id}`, {
          method: "PATCH",
          headers: auth(),
          body: JSON.stringify({ webhookUrl: appUrl, active: false, legacyMatch: false }),
        }),
        { params: Promise.resolve({ id: agenda.id }) }
      );
      expect(patch.status).toBe(200);
      expect(await prisma.app.findUniqueOrThrow({ where: { id: agenda.id } })).toMatchObject({ active: false, legacyMatch: false });

      const rotate = await import("@/app/api/admin/apps/[id]/rotate/route");
      const rotated = await (
        await rotate.POST(new Request(`http://hub/api/admin/apps/${agenda.id}/rotate`, { method: "POST", headers: auth() }), {
          params: Promise.resolve({ id: agenda.id }),
        })
      ).json();
      expect(rotated.apiKey).not.toBe(creds.apiKey);
      const { hashApiKey } = await import("@/lib/apps");
      expect((await prisma.app.findUniqueOrThrow({ where: { id: agenda.id } })).apiKeyHash).toBe(hashApiKey(rotated.apiKey));
    });
  });
});
