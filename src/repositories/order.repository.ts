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
import type { Command } from "../sync/types";
import type { POSOrderCreateRequest } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";
import { createLocalOrder } from "../domain/orders/service";

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
   * @deprecated Single create path is `createLocalOrder` (domain/orders/service)
   * — SQLite + sync_jobs + operating-hours gate. This delegate is kept for
   * backward compatibility and forwards there directly (no engine round-trip).
   */
  async createOrder(input: CreateOrderInput): Promise<SellerOrder> {
    return createLocalOrder(input.businessId, {
      ...(input.data as unknown as Record<string, unknown>),
      command_id: input.entityId,
      id: input.entityId,
    } as unknown as POSOrderCreateRequest & { is_pos?: boolean });
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
    const command = buildCommand<{ rider_id: string }>({
      commandType: "delivery:assign",
      businessId: input.businessId,
      entityId: input.orderId,
      payload: { rider_id: input.riderId },
    });
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
