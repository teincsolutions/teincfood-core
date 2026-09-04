import { eventsService } from "./events.service";

const ORDER_EVENT_TYPES = [
  "order.created",
  "order.status_changed",
  "delivery.assigned",
  "delivery.status_changed",
  "delivery.pickup_confirmed",
  "payment.completed",
  "payment.failed",
  "reference_data.changed",
];

export const orderEventsService = {
  onOrderUpdates(callback: (event: Record<string, unknown> & { type: string; order_id?: string }) => void): () => void {
    const unsubs = ORDER_EVENT_TYPES.map((type) =>
      eventsService.on(type, (data) => callback({ ...(data as Record<string, unknown>), type } as unknown as { type: string; order_id?: string })),
    );
    return () => unsubs.forEach((fn) => fn());
  },
};
