/**
 * Order Repository.
 *
 * The interface between application hooks and the Sync Engine.
 * Converts domain inputs into commands and returns the resulting events.
 *
 * In Phase 1, commands execute immediately through the REST transport.
 * Future phases will queue commands when offline.
 */

import { syncEngine } from "../sync/engine";
import { buildCommand } from "../sync/command-builder";
import { assertOnlineFor, isOnlineCapable } from "../sync/online-gates";
import { localNodeTransport } from "../sync/transport-local-node";
import type { Command } from "../sync/types";
import type { POSOrderCreateRequest } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";
import { generateUUID } from "../utils/uuid";

export interface CreateOrderInput {
  businessId: string;
  data: POSOrderCreateRequest;
  /** Client-generated entity ID for offline-created orders. */
  entityId?: string;
}

export interface AssignRiderInput {
  orderId: string;
  riderId: string;
}

export interface OrderActionInput {
  orderId: string;
  businessId: string;
}

async function executeCommand(command: Command): Promise<SellerOrder> {
  console.debug(
    "[OrderRepository] Dispatching command",
    JSON.stringify({
      command_id: command.command_id,
      command_type: command.command_type,
      business_id: command.business_id,
      entity_id: command.entity_id,
      payload_keys: Object.keys(command.payload ?? {}),
      timestamp: new Date().toISOString(),
    }),
  );
  const events = await syncEngine.execute(command);
  const event = events[0];
  console.debug(
    "[OrderRepository] Command result",
    JSON.stringify({
      command_id: command.command_id,
      command_type: command.command_type,
      event_count: events.length,
      event_type: event?.event_type,
      order_number: (event?.payload as Record<string, unknown>)?.order_number ?? null,
      status: (event?.payload as Record<string, unknown>)?.status ?? null,
      timestamp: new Date().toISOString(),
    }),
  );
  if (!event) {
    throw new Error("OrderRepository: command returned no events");
  }
  return event.payload as unknown as SellerOrder;
}

export const orderRepository = {
  /**
   * Single create path: build an `order:create` command and route it through
   * the SyncEngine (cloud → LAN node → queue). Every path returns an
   * order-shaped payload: cloud/LAN execute the real create, queue returns
   * the optimistic order (same UUID + DD-NNNN-MMM, replayed idempotently).
   * Direct `createLocalOrder` bypasses sync — never call it from UI flows.
   */
  async createOrder(input: CreateOrderInput): Promise<SellerOrder> {
    const entityId = input.entityId ?? generateUUID();
    const command = buildCommand<Record<string, unknown>>({
      commandType: "order:create",
      businessId: input.businessId,
      entityId,
      payload: {
        ...(input.data as unknown as Record<string, unknown>),
        id: entityId,
        command_id: entityId,
      },
    });
    return executeCommand(command);
  },

  async acceptOrder(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:accept",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async rejectOrder(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:reject",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async startPreparingOrder(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:start_preparing",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async markOrderReady(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:mark_ready",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async completePickup(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:complete_pickup",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async cancelOrder(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "order:cancel",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },

  async confirmHandover(input: {
    deliveryId: string;
    businessId: string;
  }): Promise<{ id: string; status: string }> {
    // Handover confirm is strictly online (dual merchant/rider confirm).
    // A connected Local Node may relay; otherwise fail loudly, never queue.
    if (!isOnlineCapable() && !localNodeTransport.isAvailable()) assertOnlineFor("delivery:confirm_handover");
    const command = buildCommand<Record<string, never>>({
      commandType: "delivery:confirm_handover",
      businessId: input.businessId,
      entityId: input.deliveryId,
      payload: {},
    });
    const events = await syncEngine.execute(command);
    const event = events[0];
    if (!event) {
      throw new Error("OrderRepository: confirmHandover returned no events");
    }
    return event.payload as { id: string; status: string };
  },

  async assignRider(input: AssignRiderInput & { businessId: string }): Promise<unknown> {
    // Delivery assignment is strictly online: auto rider-match, GPS proximity
    // and merchant/rider dual-confirm all require the backend. A connected
    // Local Node may relay to the cloud; otherwise fail loudly — never queue.
    if (!isOnlineCapable() && !localNodeTransport.isAvailable()) assertOnlineFor("delivery:assign");
    const command = buildCommand<{ rider_id: string; idempotency_key: string }>({
      commandType: "delivery:assign",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: { rider_id: input.riderId, idempotency_key: "" },
    });
    // One user action = one stable key. Replays of this command (timeout,
    // reconnect, LAN relay) must converge on the same delivery instead of
    // creating another one.
    command.payload.idempotency_key = command.command_id;
    const events = await syncEngine.execute(command);
    const event = events[0];
    if (!event) {
      throw new Error("OrderRepository: assignRider returned no events");
    }
    return event.payload;
  },

  async confirmCashPayment(input: OrderActionInput): Promise<SellerOrder> {
    const command = buildCommand<Record<string, never>>({
      commandType: "payment:confirm_cash",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: {},
    });
    return executeCommand(command);
  },
};
