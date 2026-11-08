import type { PaymentResponse, PreapprovalResponse } from "@/lib/mp";

export type HubEvent =
  | "payment.approved"
  | "payment.failed"
  | "payment.refunded"
  | "subscription.cancelled"
  | "subscription.paused";

/** Traduz o status do MP no evento que o app vai receber (null = nada a avisar). */
export function eventForPayment(status: PaymentResponse["status"]): HubEvent | null {
  switch (status) {
    case "approved":
    case "authorized":
      return "payment.approved";
    case "rejected":
    case "cancelled":
      return "payment.failed";
    case "refunded":
    case "charged_back":
      return "payment.refunded";
    default:
      return null;
  }
}

export function eventForPreapproval(status: PreapprovalResponse["status"]): HubEvent | null {
  if (status === "cancelled") return "subscription.cancelled";
  if (status === "paused") return "subscription.paused";
  return null;
}
