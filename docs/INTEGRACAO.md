# Integrar um app ao Nodum Pay

Cada app recebe duas credenciais no cadastro (no painel, `https://pay.nodumsolucoes.com/admin/apps`):

| Variável do app | Para quê |
| --- | --- |
| `NODUM_PAY_URL` | `https://api.pay.nodumsolucoes.com` |
| `NODUM_PAY_API_KEY` | autenticar `POST /api/charges` e `GET /api/payments/:id` |
| `NODUM_PAY_SIGNING_SECRET` | conferir os avisos que o hub manda |

Depois da troca, o app **não precisa mais** de `MP_ACCESS_TOKEN` nem `MP_WEBHOOK_SECRET`.

## 1. Criar cobrança

```ts
const res = await fetch(`${process.env.NODUM_PAY_URL}/api/charges`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.NODUM_PAY_API_KEY}`,
  },
  body: JSON.stringify({
    reference: barbershopId,          // o hub grava "studio:<barbershopId>"
    title: "Nodum Studio — mensalidade",
    amountCents: 4990,
    payerEmail: "dono@exemplo.com",
    onlyPix: true,                    // opcional
    backUrl: "https://studio.nodumsolucoes.com/assinatura?retorno=1", // opcional (HTTPS)
    idempotencySuffix: "MENSAL-4990", // opcional: permite nova cobrança para a mesma referência
  }),
});
const { checkoutUrl, preferenceId } = await res.json();
```

## 2. Receber o aviso

O hub faz `POST` na URL cadastrada, com este corpo:

```json
{
  "event": "payment.approved",
  "app": "studio",
  "reference": "clx9f2",
  "rawReference": "studio:clx9f2",
  "paymentId": "1234567890",
  "preapprovalId": null,
  "status": "approved",
  "amountCents": 4990,
  "method": "pix",
  "occurredAt": "2026-10-09T14:30:00.000Z",
  "deliveryId": "cmg..."
}
```

Eventos: `payment.approved`, `payment.failed`, `payment.refunded`, `subscription.cancelled`, `subscription.paused`.

Cabeçalhos: `x-nodum-signature: t=<epoch>,v1=<hmac>`, `x-nodum-event`, `x-nodum-delivery`.
O `v1` é `HMAC-SHA256(NODUM_PAY_SIGNING_SECRET, "<t>.<corpo bruto>")`. Rejeite se faltar, se não bater ou se `t` tiver mais de 5 minutos.

Responda **2xx** quando processou (ou já tinha processado). Qualquer outra resposta faz o hub tentar de novo (1 min, 5 min, 30 min, 2 h, 12 h). Por isso o tratamento precisa ser **idempotente** (use `paymentId`).

### Exemplo — Studio (Next.js)

`app/api/webhooks/nodum-pay/route.ts`, no lugar do webhook do Mercado Pago:

```ts
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { registerApprovedPayment, registerFailedPayment } from "@/services/billing/subscription.service";

function verify(body: string, header: string | null): boolean {
  const secret = process.env.NODUM_PAY_SIGNING_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!verify(body, request.headers.get("x-nodum-signature"))) {
    return NextResponse.json({ error: "assinatura inválida" }, { status: 401 });
  }
  const e = JSON.parse(body);

  if (e.event === "payment.approved") {
    await registerApprovedPayment({
      barbershopId: e.reference, amountCents: e.amountCents,
      method: e.method, gatewayPaymentId: e.paymentId,
    });
  } else if (e.event === "payment.failed") {
    await registerFailedPayment({
      barbershopId: e.reference, amountCents: e.amountCents,
      method: e.method, gatewayPaymentId: e.paymentId,
    });
  }
  // payment.refunded / subscription.*: trate conforme a regra do app.
  return NextResponse.json({ ok: true });
}
```

E em `createOneTimeCharge`, troque `createPreference(...)` pela chamada ao hub (seção 1).

## 3. Ordem segura da migração

1. Cadastre o app no hub e coloque as 3 variáveis no app; publique a rota nova do app.
2. Peça uma cobrança de teste: confirme no painel em **Pagamentos** e **Entregas**.
3. Só então troque a URL do webhook no Mercado Pago para a do hub.
4. Cobranças já criadas (sem prefixo) continuam chegando pelo app marcado como "legado".
5. Remova `MP_ACCESS_TOKEN`/`MP_WEBHOOK_SECRET` do app.
