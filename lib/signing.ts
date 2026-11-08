import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Assinatura dos avisos que o hub manda para os apps.
 *
 * Cabeçalho `x-nodum-signature: t=<epoch segundos>,v1=<hex>` onde
 * hex = HMAC-SHA256(signingSecret, `${t}.${corpo bruto}`).
 */

export function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

/** Usada pelos apps (e pelos testes) para conferir um aviso do hub. */
export function verifyHubSignature(params: {
  secret: string;
  body: string;
  header: string | null;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const { secret, body, header } = params;
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((piece) => {
      const [key, ...rest] = piece.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const ts = Number(parts.t);
  const received = parts.v1;
  if (!Number.isFinite(ts) || !received) return false;

  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (params.toleranceSeconds ?? 300)) return false;

  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
