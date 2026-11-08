import { updateApp } from "@/lib/admin";
import { adminRoute, fromResult, readJson } from "@/lib/admin-route";

type Context = { params: Promise<{ id: string }> };

/** Body: { webhookUrl, active, legacyMatch }. */
export const PATCH = adminRoute<Context>(async (request, { params }) => {
  const { id } = await params;
  return fromResult(await updateApp(id, await readJson(request)));
});
