/**
 * Shared order/delivery transition endpoint map.
 *
 * Single source used by both the sync_jobs drain (tryRest) and the REST
 * transport (executeOrderTransition) so endpoint definitions cannot drift.
 */

const ORDER_ENDPOINTS: Record<string, string> = {
  "order:accept": "accept",
  "order:reject": "reject",
  "order:start_preparing": "start-preparing",
  "order:mark_ready": "ready-for-delivery",
  "order:complete_pickup": "complete-pickup",
  "order:cancel": "cancel",
  "order:confirm_cash": "confirm-cash-payment",
  "order:pay": "confirm-cash-payment",
  "order:assign_rider": "assign",
};

/**
 * Build the REST path for a given command type and order/delivery ID.
 * Returns null for unknown command types.
 */
export function getTransitionPath(commandType: string, entityId: string): string | null {
  if (commandType === "order:confirm_handover") {
    return `/deliveries/${entityId}/confirm-handover`;
  }
  const suffix = ORDER_ENDPOINTS[commandType];
  if (!suffix) return null;
  return `/orders/${entityId}/${suffix}`;
}
