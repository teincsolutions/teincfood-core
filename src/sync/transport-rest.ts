/**
 * REST transport implementation.
 *
 * Translates domain commands into existing service calls and returns the
 * resulting domain events. This transport is used when the cloud API is
 * reachable.
 */

import type { Command, DomainEvent, Transport } from "./types";
import { sellerService, kioskService, menuService, businessService } from "../adapters/services";
import { syncLogger } from "../utils/sync-logger";
import { generateEventId } from "../utils/uuid";
import type { POSOrderCreateRequest } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";
import { createLocalOrder, transitionLocalOrder } from "../domain/orders/service";
import { isFinalGuardRejection } from "./transition-errors";
import { getQueuedStatus } from "../utils/order-transitions";
import { openSyncDatabase } from "../db/connection";
import { getOrderById, updateOrderStatus } from "../db/operations";

export class RestTransport implements Transport {
  readonly name = "rest";

  isAvailable(): boolean {
    // Availability is determined by the Sync Engine based on connectivity.
    return true;
  }

  subscribe(): () => void {
    // Events from the cloud arrive via Phoenix Channels, not push replies.
    // This transport does not push events itself.
    return () => undefined;
  }

  async execute(command: Command): Promise<DomainEvent[]> {
    syncLogger.transport(this, "executing", {
      command_type: command.command_type,
      command_id: command.command_id,
    });

    try {
      const event = await this.dispatchCommand(command);

      syncLogger.transport(this, "completed", {
        command_type: command.command_type,
        event_type: event?.event_type,
      });

      return event ? [event] : [];
    } catch (error) {
      syncLogger.transport(this, "error", {
        command_type: command.command_type,
        command_id: command.command_id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async dispatchCommand(
    command: Command,
  ): Promise<DomainEvent | null> {
    const { command_type, business_id, entity_id, payload } = command;
    // Use the command's original timestamp (set at creation time) so the event
    // reflects when the mutation actually happened, not when it was dispatched.
    const timestamp = command.timestamp || new Date().toISOString();

    switch (command_type) {
      // Single create path — createLocalOrder owns SQLite + sync_jobs + the
      // operating-hours gate. No direct-REST fallback: guard rejections
      // (BUSINESS_CLOSED / HOURS_NOT_SYNCED) must stand, never be bypassed.
      case "order:create": {
        const order = await createLocalOrder(business_id, {
          ...((payload ?? {}) as Record<string, unknown>),
          command_id: command.command_id,
          id: entity_id ?? command.command_id,
        } as unknown as POSOrderCreateRequest);
        return this.wrapResponse("order.created", order as unknown as Record<string, unknown>, order.id, timestamp, command);
      }

      case "order:accept": {
        return this.executeOrderTransition(command, "accept", timestamp, () => sellerService.acceptOrder(entity_id!));
      }

      case "order:reject": {
        return this.executeOrderTransition(command, "reject", timestamp, () => sellerService.rejectOrder(entity_id!));
      }

      case "order:start_preparing": {
        return this.executeOrderTransition(command, "start_preparing", timestamp, () => sellerService.startPreparingOrder(entity_id!));
      }

      case "order:mark_ready": {
        return this.executeOrderTransition(command, "mark_ready", timestamp, () => sellerService.markOrderReady(entity_id!));
      }

      case "order:complete_pickup": {
        return this.executeOrderTransition(command, "complete_pickup", timestamp, () => sellerService.completeOrderPickup(entity_id!));
      }

      case "order:cancel": {
        return this.executeOrderTransition(command, "cancel", timestamp, () => sellerService.cancelOrder(entity_id!));
      }

      case "delivery:assign": {
        const assignPayload = payload as {
          rider_id: string;
          idempotency_key?: string;
        };
        const response = await kioskService.assignKioskOrderToRider(
          entity_id!,
          assignPayload.rider_id,
          assignPayload.idempotency_key ?? command.command_id,
        );
        return this.wrapResponse("delivery.assigned", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "delivery:confirm_handover": {
        const response = await sellerService.confirmHandover(entity_id!);
        return this.wrapResponse("delivery.status_changed", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "menu:create_item": {
        // cacheRecord is local-cache only — strip it so the backend receives
        // the flat wire payload it accepts (it owns canonical on converge).
        const { cacheRecord: _omitCreate, ...wireCreate } = payload as Record<string, unknown>;
        void _omitCreate;
        const createPayload = { ...wireCreate, id: wireCreate.id ?? command.command_id, command_id: command.command_id };
        const response = await menuService.createMenuItem(business_id, createPayload);
        return this.wrapResponse("menu.item_created", response as unknown as Record<string, unknown>, command.command_id, timestamp, command);
      }

      case "menu:update_item": {
        const { cacheRecord: _omitUpdate, ...wireUpdate } = payload as Record<string, unknown>;
        void _omitUpdate;
        const response = await menuService.updateMenuItem(entity_id!, wireUpdate);
        return this.wrapResponse("menu.item_updated", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "menu:delete_item": {
        const response = await menuService.deleteMenuItem(entity_id!);
        return this.wrapResponse("menu.item_deleted", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "menu:create_category": {
        const { cacheRecord: _omitCatCreate, ...wireCatCreate } = payload as Record<string, unknown>;
        void _omitCatCreate;
        const createPayload = { ...wireCatCreate, id: wireCatCreate.id ?? command.command_id, command_id: command.command_id };
        const response = await menuService.createCategory(business_id, createPayload);
        return this.wrapResponse("menu.category_created", response as unknown as Record<string, unknown>, command.command_id, timestamp, command);
      }

      case "menu:update_category": {
        const { cacheRecord: _omitCatUpdate, ...wireCatUpdate } = payload as Record<string, unknown>;
        void _omitCatUpdate;
        const response = await (menuService as unknown as { updateCategory: (id: string, p: unknown) => Promise<unknown> }).updateCategory(entity_id!, wireCatUpdate);
        return this.wrapResponse("menu.category_updated", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "menu:delete_category": {
        const response = await (menuService as unknown as { deleteCategory: (id: string) => Promise<unknown> }).deleteCategory(entity_id!);
        return this.wrapResponse("menu.category_deleted", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "payment:confirm_cash": {
        return this.executeOrderTransition(command, "confirm_cash", timestamp, () => sellerService.confirmCashPayment(entity_id!), "payment.completed");
      }

      case "member:invite": {
        const response = (await businessService.inviteBusinessMember(
          business_id,
          (payload ?? {}) as Record<string, unknown>,
        )) as { data?: Record<string, unknown> };
        const data = (response?.data ?? {}) as Record<string, unknown>;
        return this.wrapResponse(
          "member.invited",
          data,
          (data.id as string) ?? command.command_id,
          timestamp,
          command,
        );
      }

      case "member:update": {
        if (!entity_id) throw new Error("member:update requires entity_id");
        const response = (await businessService.updateBusinessMember(
          business_id,
          entity_id,
          (payload ?? {}) as Record<string, unknown>,
        )) as { data?: Record<string, unknown> };
        const data = (response?.data ?? {}) as Record<string, unknown>;
        return this.wrapResponse("member.updated", data, entity_id, timestamp, command);
      }

      case "member:remove": {
        if (!entity_id) throw new Error("member:remove requires entity_id");
        await businessService.removeBusinessMember(business_id, entity_id);
        return this.wrapResponse(
          "member.removed",
          { user_id: entity_id, status: "removed" },
          entity_id,
          timestamp,
          command,
        );
      }

      default:
        throw new Error(`RestTransport: unsupported command type ${command_type}`);
    }
  }

  /**
   * Order transitions go through the domain service first (single write path:
   * SQLite + sync_jobs). Direct-REST fallback is ONLY for devices that never
   * saw the order (LAN node handling a cloud-created order before first pull).
   * Local guard rejections (Cannot <action>, online-required, auth/business,
   * capability) are rethrown — POSTing past them is what caused the
   * complete-pickup 422 storm on delivery orders.
   */
  private async executeOrderTransition(
    command: Command,
    action: string,
    timestamp: string,
    restFallback: () => Promise<{ data: unknown }>,
    eventType = "order.status_changed",
  ): Promise<DomainEvent | null> {
    const { business_id, entity_id } = command;
    // Idempotent absorb: a duplicate tap / replayed command whose target
    // status is already applied locally succeeds without touching the
    // guards or the network (this was the "Cannot mark_ready from ready"
    // error storm: the throw also poisoned global reachability before the
    // probe-ownership rule). Genuinely invalid transitions still throw
    // INVALID_TRANSITION from transitionLocalOrder below.
    const target = getQueuedStatus(command.command_type);
    if (target && entity_id) {
      try {
        const db = await openSyncDatabase();
        const local = await getOrderById(db, business_id, entity_id);
        if (local && local.status === target) {
          syncLogger.info("RestTransport", "transition already applied, absorbing", {
            command_type: command.command_type,
            entity_id,
            status: target,
          });
          const data: Record<string, unknown> = { ...local, order_id: local.id };
          return this.wrapResponse(eventType, data, local.id, timestamp, command);
        }
      } catch {}
    }
    try {
      const order = await transitionLocalOrder(business_id, entity_id!, action);
      const data: Record<string, unknown> = { ...order, order_id: order.id };
      return this.wrapResponse(eventType, data, order.id, timestamp, command);
    } catch (error) {
      // Guard rejections (by code, never message text) must stand — never
      // POST past them. Only ORDER_NOT_FOUND falls back to REST.
      if (isFinalGuardRejection(error)) throw error;
      syncLogger.warn("RestTransport", "domain transition unavailable, REST fallback", {
        command_type: command.command_type,
        entity_id,
        error: error instanceof Error ? error.message : String(error),
      });
      const response = await restFallback();
      const raw = response.data as Record<string, unknown> | undefined;
      const data: Record<string, unknown> = { ...raw };
      const orderId = (data.id as string) ?? entity_id;
      if (!data.order_id) data.order_id = orderId;
      if (business_id && orderId) {
        try {
          const db = await openSyncDatabase();
          const existing = await getOrderById(db, business_id, orderId);
          if (existing) {
            const newStatus = (data.status as string) ?? existing.status;
            if (newStatus !== existing.status) {
              await updateOrderStatus(db, business_id, orderId, newStatus);
            }
          }
        } catch {}
      }
      return this.wrapResponse(eventType, data, orderId, timestamp, command);
    }
  }

  private wrapResponse(
    eventType: string,
    data: Record<string, unknown>,
    entityId: string | undefined,
    timestamp: string,
    command: Command,
  ): DomainEvent {
    return {
      event_id: generateEventId(),
      event_type: eventType,
      event_version: "1.0",
      entity_id: entityId ?? command.entity_id ?? data.id as string ?? "unknown",
      user_id: command.user_id,
      device_id: command.device_id,
      payload: data,
      timestamp,
    };
  }
}

export const restTransport = new RestTransport();
