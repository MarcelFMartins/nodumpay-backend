# Nodum Pay — backend (API)

Hub de pagamentos dos sistemas Nodum (Studio, Barber e os próximos). **Só o Nodum Pay fala com o Mercado Pago**: os apps pedem a cobrança a ele e recebem dele o aviso de pagamento.

```
App  ──1. POST /api/charges──▶  Nodum Pay  ──2. cria cobrança──▶  Mercado Pago
App  ◀──4. aviso assinado─────  Nodum Pay  ◀──3. webhook────────  Mercado Pago
                                    ▲
                                    │ /api/admin/* (ADMIN_API_TOKEN)
                              Painel (nodumpay-frontend, Vercel)
```

Este repositório é a **API** e roda em Docker na VPS (Dokploy), usando o Postgres compartilhado. O painel fica em [`nodumpay-frontend`](https://github.com/MarcelFMartins/nodumpay-frontend) (Vercel) e lê tudo por `/api/admin/*`.

- **Uma só URL de webhook** no Mercado Pago: `https://api.pay.nodumsolucoes.com/api/webhooks/mercadopago`.
- **Quem é o dono do pagamento** vem do `external_reference`, sempre `<slug>:<referência>` (ex.: `studio:clx9f2`).
- **Cobranças antigas** (referência sem prefixo) vão para o app marcado como "legado".
- **Aviso nunca se perde**: o corpo bruto fica em `Event`; a entrega ao app tem retry (1 min, 5 min, 30 min, 2 h, 12 h), reenvio automático a cada 60 s dentro do próprio processo e botão de reenvio no painel.
- **Idempotente**: o mesmo pagamento avisado várias vezes pelo MP gera uma entrega só.

## Stack

Next.js 15 (só rotas de API) · Prisma 6 · PostgreSQL 17 · Docker (Dokploy).

## Rotas

| Rota | Quem chama | O que faz |
| --- | --- | --- |
| `POST /api/webhooks/mercadopago` | Mercado Pago | Confere `x-signature`, grava o aviso, consulta o pagamento na API do MP, cria a entrega e responde |
| `POST /api/charges` | Apps (`Bearer <apiKey>`) | Cria a cobrança no MP com o prefixo do app; devolve `checkoutUrl` |
| `GET /api/payments/:id` | Apps (`Bearer <apiKey>`) | Consulta um pagamento do próprio app |
| `POST /api/subscriptions` | Apps (`Bearer <apiKey>`) | Cria assinatura recorrente no cartão (preapproval) com o prefixo do app; devolve `checkoutUrl` |
| `GET /api/subscriptions/:id` | Apps (`Bearer <apiKey>`) | Consulta uma assinatura do próprio app |
| `POST /api/subscriptions/:id/cancel` | Apps (`Bearer <apiKey>`) | Cancela a renovação automática |
| `GET /api/health` | Monitor de uptime / Docker | 200 se o banco responde |
| `GET /api/cron/deliveries` | Agendador externo, opcional (`Bearer $CRON_SECRET`) | Reenvia entregas pendentes |
| `GET /api/admin/overview` | Painel (`Bearer $ADMIN_API_TOKEN`) | KPIs do mês, série de 30 dias, saúde, erros recentes |
| `GET /api/admin/payments?app=&status=` | Painel | Últimos 100 pagamentos |
| `GET /api/admin/deliveries?status=` | Painel | Últimas 100 entregas |
| `POST /api/admin/deliveries/:id/resend` | Painel | Reenvio manual |
| `GET` / `POST /api/admin/apps` | Painel | Lista / cadastra app (credenciais aparecem uma vez) |
| `PATCH /api/admin/apps/:id` | Painel | Edita URL, ativo, "cobranças antigas" |
| `POST /api/admin/apps/:id/rotate` | Painel | Gera novas credenciais |

## Rodar localmente

```bash
cp .env.example .env     # preencha (DATABASE_URL de um Postgres local)
npm install
npm run db:migrate       # aplica prisma/migrations
npm run dev              # http://localhost:3001
```

Para webhooks locais sem assinatura: `ALLOW_UNSIGNED_WEBHOOKS=true` (nunca em produção).

## Testes

```bash
npm test                                                   # unitários
TEST_DATABASE_URL=postgresql://...nodumpay_test npm test   # + fluxo completo e API do painel com Postgres real
```

O teste de integração sobe um Mercado Pago falso e um app falso, e só roda em banco com "test" no nome (ele limpa as tabelas).

## Documentação

- [Deploy (Dokploy + Postgres compartilhado + Mercado Pago)](docs/DEPLOY.md)
- [Integrar um app (Studio, Barber, futuros)](docs/INTEGRACAO.md)
