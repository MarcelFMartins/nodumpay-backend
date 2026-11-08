/**
 * Roda uma vez quando o servidor sobe. Na VPS (Dokploy) o processo fica vivo,
 * então o próprio hub reenvia as entregas vencidas a cada N segundos — sem
 * depender de cron externo. A reserva (lease) em `attemptDelivery` impede que
 * duas execuções (ou duas réplicas) mandem a mesma entrega.
 *
 * DELIVERY_RETRY_INTERVAL_SECONDS: padrão 60; "0" desliga.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  const seconds = Number(process.env.DELIVERY_RETRY_INTERVAL_SECONDS ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  const { retryDue } = await import("@/lib/delivery");
  const { logger } = await import("@/lib/logger");

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await retryDue(100);
      if (result.tried > 0) logger.info("Reenvio automático", result);
    } catch (e) {
      logger.error("Reenvio automático falhou", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  };

  setInterval(tick, seconds * 1000).unref();
  logger.info("Reenvio automático ligado", { intervalSeconds: seconds });
}
