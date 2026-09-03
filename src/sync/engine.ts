/**
 * Sync Engine orchestrator.
 *
 * Phase 1 responsibility: receive commands from repositories and route them
 * to the active transport (currently REST only).
 *
 * Future phases will add:
 *   - connectivity-aware transport selection
 *   - command outbox persistence
 *   - replay
 *   - Local Node transport
 *   - cloud reconciliation
 */

import type { Command, DomainEvent, Transport } from "./types";
import { restTransport } from "./transport-rest";
import { localNodeTransport } from "./transport-local-node";
import { commandQueueService } from "./command-queue.service";
import { getConnectivityState, setConnectivityState } from "../adapters/connectivity";
import { ApiError } from "../adapters/http";
import { syncLogger } from "../utils/sync-logger";
import { CLOUD_COMMAND_TIMEOUT_MS } from "../utils/constants";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface SyncEngineOptions {
  /** Ordered list of transports the engine may use. */
  transports: Transport[];
}

export class SyncEngine {
  private transports: Transport[];
  private eventSubscribers: Array<(event: DomainEvent) => void> = [];

  constructor(options: SyncEngineOptions) {
    this.transports = options.transports;
  }

  /**
   * Execute a command through the appropriate transport.
   *
   * Transport selection:
   *   - Cloud reachable and REST transport available → REST
   *   - Local Node enabled and available → LocalNodeTransport
   *   - Otherwise queue locally and return an optimistic event
   *
   * Cloud commands are raced against CLOUD_COMMAND_TIMEOUT_MS so a slow
   * internet connection falls back to the Local Node (or the offline outbox)
   * quickly instead of blocking the terminal for the full HTTP timeout.
   */
  async execute(command: Command): Promise<DomainEvent[]> {
    syncLogger.command(command, "issued");

    // Perms guard (offline-capable): block before routing
    const { CAPABILITY_BY_COMMAND } = await import("../reference/capabilities");
    const required = CAPABILITY_BY_COMMAND[command.command_type];
    if (required) {
      try {
        const { getReferenceData } = await import("../reference/operations");
        const { openSyncDatabase } = await import("../db/connection");
        const db = await openSyncDatabase();
        const rec = await getReferenceData(db, command.business_id, "capabilities");
        const caps: string[] = (rec?.payload as unknown as { data?: { capabilities?: string[] } })?.data?.capabilities ?? [];
        // If capabilities cached and missing required, block locally
        if (rec && caps.length > 0 && !caps.includes(required)) {
          throw new ApiError(`Missing capability: ${required}`, 403, "FORBIDDEN");
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) throw e;
        // otherwise fail open
      }
    }

    let strategy = this.resolveStrategy(command);

    const { isCloudReachable, isOnline } = getConnectivityState();
    syncLogger.info("SyncEngine", "Command strategy resolved", {
      command_id: command.command_id,
      command_type: command.command_type,
      strategy,
      isCloudReachable,
      isOnline,
      cloud_available: restTransport.isAvailable(),
      lan_available: localNodeTransport.isAvailable(),
    });

    if (strategy === "queue") {
      const event = await commandQueueService.enqueue(command);
      this.broadcast(event);
      return [event];
    }

    if (strategy === "cloud") {
      try {
        const events = await withTimeout(
          restTransport.execute(command),
          CLOUD_COMMAND_TIMEOUT_MS,
        );
        for (const event of events) {
          this.broadcast(event);
        }
        syncLogger.command(command, "completed", {
          event_count: events.length,
        });
        // Cloud just worked: it is reachable again. Mark it so future commands
        // go cloud-first, and replay anything queued during the outage.
        setConnectivityState({ isCloudReachable: "reachable" });
        this.replayQueuedCommands().catch((error) => {
          syncLogger.error("SyncEngine", "Replay after cloud success failed", {
            error: String(error),
          });
        });
        return events;
      } catch (error) {
        // Definitive server rejection (4xx): the backend answered with a real
        // decision (e.g. PAYMENT_REQUIRED, FORBIDDEN). Surface it to the
        // caller instead of masking it as a connectivity problem and silently
        // queueing a command that can never succeed.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          syncLogger.warn("SyncEngine", "Cloud command rejected by server", {
            command_type: command.command_type,
            command_id: command.command_id,
            status: error.status,
            message: error.message,
          });
          throw error;
        }

        // Cloud is slow or unreachable: mark it and fall back to the Local
        // Node or the outbox so the terminal stays responsive.
        syncLogger.warn("SyncEngine", "Cloud command timed out, falling back", {
          command_type: command.command_type,
          error: String(error),
        });
        setConnectivityState({ isCloudReachable: "unreachable" });
        strategy = this.resolveStrategy(command);
        if (strategy === "queue") {
          const event = await commandQueueService.enqueue(command);
          this.broadcast(event);
          return [event];
        }
        syncLogger.info("SyncEngine", "Cloud timed out, using LAN fallback", {
          command_id: command.command_id,
          command_type: command.command_type,
          strategy,
        });
      }
    }

    const transport = this.selectTransport(command, strategy);
    syncLogger.info("SyncEngine", "Executing via transport", {
      command_id: command.command_id,
      command_type: command.command_type,
      strategy,
      transport: transport.name,
    });

    const events = await transport.execute(command);

    for (const event of events) {
      this.broadcast(event);
    }

    syncLogger.command(command, "completed", {
      event_count: events.length,
      transport: transport.name,
    });

    return events;
  }

  /**
   * Trigger replay of queued commands when connectivity returns.
   */
  async replayQueuedCommands(): Promise<void> {
    await commandQueueService.replay();
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    this.eventSubscribers.push(handler);
    return () => {
      const index = this.eventSubscribers.indexOf(handler);
      if (index > -1) {
        this.eventSubscribers.splice(index, 1);
      }
    };
  }

  /**
   * Publish a notification event to local subscribers without a transport
   * round-trip. Used for cross-device notifications (e.g. reference data
   * changed) that are not backed by a command: the event is broadcast locally
   * so the reconciliation bridge can relay it to LAN clients.
   */
  publish(event: DomainEvent): void {
    this.broadcast(event);
  }

  private resolveStrategy(_command: Command): "cloud" | "local_node" | "queue" {
    const { isCloudReachable, isOnline } = getConnectivityState();

    // Cloud-first when we believe it is reachable OR we have not yet verified
    // it (unknown). Only a confirmed "unreachable" status falls back to the
    // Local Node / outbox. Commands issued on a healthy connection must never
    // get stuck in the local outbox.
    if (
      (isCloudReachable === "reachable" || isCloudReachable === "unknown") &&
      restTransport.isAvailable()
    ) {
      return "cloud";
    }

    // Local Node fallback when enabled and connected.
    if (localNodeTransport.isAvailable()) {
      return "local_node";
    }

    // No network at all: queue immediately.
    if (!isOnline) {
      return "queue";
    }

    // Network present but cloud status unknown or unreachable. Try cloud first;
    // a failed HTTP call will bubble up and the caller (e.g. queue replay) can
    // decide to retry. New commands issued while cloud is unknown are queued to
    // avoid blocking the UI on a flaky connection.
    if (isCloudReachable === "unreachable") {
      return "queue";
    }

    return "cloud";
  }

  private selectTransport(
    _command: Command,
    strategy: "cloud" | "local_node" | "queue",
  ): Transport {
    if (strategy === "local_node" && localNodeTransport.isAvailable()) {
      return localNodeTransport;
    }

    if (strategy === "cloud" && restTransport.isAvailable()) {
      return restTransport;
    }

    const transport = this.transports.find((t) => t.isAvailable()) ?? this.transports[0];
    if (!transport) {
      throw new Error("SyncEngine: no transports configured");
    }
    return transport;
  }

  private broadcast(event: DomainEvent): void {
    syncLogger.event(event, "broadcast");
    this.eventSubscribers.forEach((handler) => handler(event));
  }
}

export const syncEngine = new SyncEngine({
  transports: [restTransport, localNodeTransport],
});

commandQueueService.setSyncEngine(syncEngine);
