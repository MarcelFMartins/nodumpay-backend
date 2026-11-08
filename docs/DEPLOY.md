# Deploy — backend na VPS (Dokploy) + painel na Vercel

| Peça | Onde | Domínio |
| --- | --- | --- |
| `nodumpay-backend` (este repo) | VPS Platon, Dokploy, Dockerfile | `api.pay.nodumsolucoes.com` |
| Banco `nodumpay` | Postgres 17 compartilhado (compose "Banco de Dados") | só rede interna |
| `nodumpay-frontend` (painel) | Vercel | `pay.nodumsolucoes.com` |

Ordem: banco → backend → DNS → painel → Mercado Pago → cadastrar apps.

## 1. Banco (no Postgres que você já tem)

Não precisa de compose novo: só um banco novo no mesmo Postgres 17. No Dokploy, abra o compose **Banco de Dados** → terminal do container do Postgres:

```bash
psql -U <usuario_admin> -c "CREATE DATABASE nodumpay;"
```

O `DATABASE_URL` do backend é o mesmo que os outros projetos usam, trocando só o nome do banco no fim:

```
postgresql://<usuario>:<senha>@<host-do-postgres>:5432/nodumpay
```

> O `<host-do-postgres>` é o mesmo que já está no env dos outros projetos (nome do serviço/container do compose na rede do Dokploy). As tabelas são criadas sozinhas: o container roda `prisma migrate deploy` toda vez que sobe.

## 2. Backend (Application no Dokploy)

1. No projeto que preferir, **Create Service → Application** `nodumpay-backend`.
2. **Provider**: GitHub → `MarcelFMartins/nodumpay-backend`, branch `main`.
3. **Build Type**: **Dockerfile** (caminho `Dockerfile`, contexto `.`).
4. **Environment**:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | do passo 1 |
| `MP_ACCESS_TOKEN` | Access Token de **produção** (`APP_USR-...`) |
| `MP_WEBHOOK_SECRET` | "Assinatura secreta" do webhook (passo 5) |
| `APP_URL` | `https://api.pay.nodumsolucoes.com` |
| `ADMIN_API_TOKEN` | `openssl rand -base64 48` — **o mesmo vai na Vercel** |
| `DELIVERY_RETRY_INTERVAL_SECONDS` | `60` (opcional; `0` desliga o reenvio interno) |
| `CRON_SECRET` | opcional — só se for usar agendador externo |

5. **Domains**: host `api.pay.nodumsolucoes.com`, path `/`, **container port `3000`**, HTTPS com **Let's Encrypt**.
6. **Deploy**. Nos logs: `All migrations have been successfully applied.` e `Reenvio automático ligado`.
7. Ligue **Auto Deploy** para publicar a cada push na `main`.

> O container precisa estar na mesma rede Docker do Postgres (a `dokploy-network`, como os outros projetos). Se o deploy falhar com "Can't reach database server", confira se o compose do banco está nessa rede.

## 3. DNS

No DNS de `nodumsolucoes.com`:

- **A** `api.pay` → IP da VPS Platon (backend).
- **CNAME** `pay` → o valor que a Vercel mostrar em Domains (painel).

Teste: `https://api.pay.nodumsolucoes.com/api/health` → `{"ok":true}`.

## 4. Painel (Vercel)

Importe `MarcelFMartins/nodumpay-frontend` na Vercel e defina:

| Variável | Valor |
| --- | --- |
| `BACKEND_URL` | `https://api.pay.nodumsolucoes.com` |
| `ADMIN_API_TOKEN` | o mesmo do backend |
| `ADMIN_PASSWORD` | senha longa do painel |
| `AUTH_SECRET` | `openssl rand -base64 48` |

Domínio: `pay.nodumsolucoes.com`. Entre em `https://pay.nodumsolucoes.com` — o cartão **Saúde do sistema** já mostra o que falta no backend.

## 5. Mercado Pago

O hub pode usar a mesma aplicação do Barber **ou** uma nova.

- **Aplicação nova (recomendado)**: developers → Suas integrações → Criar aplicação (Pagamentos online). Ative as credenciais de produção e copie o Access Token.
- **Webhooks** da aplicação (modo Produção): URL `https://api.pay.nodumsolucoes.com/api/webhooks/mercadopago`, eventos **Pagamentos** e **Planos e assinaturas**. Salve e copie a **Assinatura secreta** → `MP_WEBHOOK_SECRET` no Dokploy → **Redeploy**.
- Se reaproveitar a aplicação do Barber, a URL antiga dela é **substituída** pela do hub. Faça a troca só depois de cadastrar o Barber no hub (passo 6) e de o Barber aceitar o aviso do hub.

## 6. Cadastrar os apps

No painel → **Apps** → Novo app:

| Campo | Studio | Barber |
| --- | --- | --- |
| Slug | `studio` | `barber` |
| URL dos avisos | `https://studio.nodumsolucoes.com/api/webhooks/nodum-pay` | a rota equivalente do Barber |
| Cobranças antigas sem prefixo | **marcar** (todas as do Studio hoje) | desmarcar |

O painel mostra a **API key** e o **signing secret** uma única vez. Guarde nas variáveis do app (veja [INTEGRACAO.md](INTEGRACAO.md)).

> Só um app pode ter "cobranças antigas" ligado. Se Studio e Barber já têm cobranças sem prefixo em aberto, deixe ligado no que tiver mais e peça ao outro para cobrar já com prefixo; as antigas do outro aparecem em **Pagamentos** como "sem app".

## 7. Reenvio automático e monitoramento

O hub reenvia sozinho as entregas vencidas a cada `DELIVERY_RETRY_INTERVAL_SECONDS` (padrão 60 s) e também a cada webhook recebido. Duas execuções nunca mandam a mesma entrega (há uma reserva de 2 min por entrega).

Para usar um agendador externo no lugar, defina `DELIVERY_RETRY_INTERVAL_SECONDS=0` e `CRON_SECRET`, e chame `GET /api/cron/deliveries` com `Authorization: Bearer <CRON_SECRET>`.

Aponte um monitor de uptime (UptimeRobot, Uptime Kuma) para `GET /api/health`. A imagem tem `HEALTHCHECK`, então o Docker marca o container como *unhealthy* se o banco cair.

## 8. Backup

Os pagamentos ficam no banco `nodumpay` do Postgres compartilhado: inclua-o no backup que você já faz dos outros bancos (ou em **Backups** do Dokploy, se o banco estiver lá como Database).

## 9. Conferir

No painel, **Saúde do sistema** todo verde. Faça um pagamento de teste (PIX de valor baixo) e confirme em **Pagamentos** e **Entregas**.
