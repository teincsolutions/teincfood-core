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
  // Repository/queue alias. The domain transition queues `order:confirm_cash`,
  // but an offline repository command is enqueued as `payment:confirm_cash`;
  // both must resolve to the same backend route.
  "payment:confirm_cash": "confirm-cash-payment",
};

/** Command types fulfilled by the delivery endpoints (strictly online). */
export const DELIVERY_COMMANDS = new Set([
  "delivery:assign",
  "delivery:confirm_handover",
  "order:assign_rider",
  "order:confirm_handover",
]);

/**
 * Order-scoped transitions. Every one of these operates on an order that must
 * already exist server-side (the `order:create` for the same entity_id must
 * have landed). Used to enforce create-before-transition ordering and to make
 * a 404 on a transition terminal instead of a blind retry: a transition whose
 * order is gone can never succeed by being replayed.
 */
export const ORDER_TRANSITION_COMMANDS = new Set([
  "order:accept",
  "order:reject",
  "order:start_preparing",
  "order:mark_ready",
  "order:complete_pickup",
  "order:cancel",
  "order:confirm_cash",
  "order:pay",
  "payment:confirm_cash",
]);

export function isOrderCreate(commandType: string): boolean {
  return commandType === "order:create";
}

export function isOrderTransition(commandType: string): boolean {
  return ORDER_TRANSITION_COMMANDS.has(commandType);
}

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
