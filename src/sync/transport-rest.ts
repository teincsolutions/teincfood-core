/**
 * REST transport implementation.
 *
 * Translates domain commands into existing service calls and returns the
 * resulting domain events. This transport is used when the cloud API is
 * reachable.
 */

import type { Command, DomainEvent, Transport } from "./types";
import { posService, sellerService, kioskService } from "../adapters/services";
import { syncLogger } from "../utils/sync-logger";
import { generateEventId } from "../utils/uuid";
import type { POSOrderCreateRequest } from "../types/pos.types";

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
    const timestamp = new Date().toISOString();

    switch (command_type) {
      case "order:create": {
        const posPayload = {
          ...(payload as unknown as POSOrderCreateRequest),
          command_id: command.command_id,
          local_order_number: (payload as { order_number?: string }).order_number,
        };
        const response = await posService.createPOSOrder(
          business_id,
          posPayload as unknown as POSOrderCreateRequest,
        );
        return this.wrapResponse("order.created", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:accept": {
        const response = await sellerService.acceptOrder(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:reject": {
        const response = await sellerService.rejectOrder(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:start_preparing": {
        const response = await sellerService.startPreparingOrder(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:mark_ready": {
        const response = await sellerService.markOrderReady(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:complete_pickup": {
        const response = await sellerService.completeOrderPickup(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "order:cancel": {
        const response = await sellerService.cancelOrder(entity_id!);
        return this.wrapResponse("order.status_changed", response.data as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "delivery:assign": {
        const response = await kioskService.assignKioskOrderToRider(
          entity_id!,
          (payload as { rider_id: string }).rider_id,
        );
        return this.wrapResponse("delivery.assigned", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      case "delivery:confirm_handover": {
        const response = await sellerService.confirmHandover(entity_id!);
        return this.wrapResponse("delivery.status_changed", response as unknown as Record<string, unknown>, entity_id, timestamp, command);
      }

      default:
        throw new Error(`RestTransport: unsupported command type ${command_type}`);
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
