/**
 * Shared order/delivery transition endpoint map.
 *
 * Single source used by both the sync_jobs drain (tryRest) and the REST
 * transport (executeOrderTransition) so endpoint definitions cannot drift.
 *
 * Delivery commands do NOT live under /orders/:id — backend routes are
 * POST /deliveries/assign {order_id, rider_id} and
 * POST /deliveries/:deliveryId/confirm-handover. tryRest builds those
 * bodies/paths (resolving delivery_id from SQLite when needed).
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
};

/** Command types fulfilled by the delivery endpoints (strictly online). */
export const DELIVERY_COMMANDS = new Set([
  "delivery:assign",
  "delivery:confirm_handover",
  "order:assign_rider",
  "order:confirm_handover",
]);

/**
 * Build the REST path for a given command type and order/delivery ID.
 * Returns null for unknown command types AND for delivery commands, which
 * need body/path resolution in tryRest (rider_id, delivery_id lookup).
 */
export function getTransitionPath(commandType: string, entityId: string): string | null {
  if (DELIVERY_COMMANDS.has(commandType)) return null;
  const suffix = ORDER_ENDPOINTS[commandType];
  if (!suffix) return null;
  return `/orders/${entityId}/${suffix}`;
}
