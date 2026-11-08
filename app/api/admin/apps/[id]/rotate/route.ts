import { rotateCredentials } from "@/lib/admin";
import { adminRoute, fromResult } from "@/lib/admin-route";

type Context = { params: Promise<{ id: string }> };

/** Gera novas credenciais; as anteriores deixam de valer na hora. */
export const POST = adminRoute<Context>(async (_request, { params }) => {
  const { id } = await params;
  return fromResult(await rotateCredentials(id));
});
