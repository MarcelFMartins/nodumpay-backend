import { createHash, randomBytes } from "node:crypto";
import type { App } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Segredos nascem aqui e só aparecem uma vez, na tela de cadastro. */
export function generateCredentials() {
  const apiKey = `npk_${randomBytes(24).toString("base64url")}`;
  const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
  return { apiKey, apiKeyHash: hashApiKey(apiKey), signingSecret };
}

/** Autentica um app pelo cabeçalho `Authorization: Bearer <apiKey>`. */
export async function authenticateApp(request: Request): Promise<App | null> {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const app = await prisma.app.findUnique({ where: { apiKeyHash: hashApiKey(match[1].trim()) } });
  return app && app.active ? app : null;
}
