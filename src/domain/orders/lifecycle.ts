/**
 * Food order lifecycle — explicit transitions, payment independent (§19).
 * Single source: src/utils/order-transitions. Re-export for domain structure.
 */
export * from "../../utils/order-transitions";
export { orderRepository } from "../../repositories/order.repository";
