/**
 * Local Node Transport.
 *
 * Routes commands to the elected Local Node over the LAN and receives events
 * broadcast by the Local Node.
 */

import type { Command, DomainEvent, Transport } from "./types";
import { useLocalNodeStore, localNodeService } from "../adapters/local-node";
import { syncLogger } from "../utils/sync-logger";

export class LocalNodeTransport implements Transport {
  readonly name = "local_node";

  isAvailable(): boolean {
    const store = useLocalNodeStore.getState();
    if (!store.isLocalNodeEnabled) return false;

    // If this device is the Local Node, it is always available.
    if (localNodeService.isLocalNode()) return true;

    // Otherwise, we must be connected to the elected node.
    return localNodeService.isConnectedToNode();
  }

  subscribe(): () => void {
    // Events are received through the LocalNodeService event pipeline.
    return () => undefined;
  }

  async execute(command: Command): Promise<DomainEvent[]> {
    syncLogger.transport(this, "executing", {
      command_type: command.command_type,
      command_id: command.command_id,
    });

    if (localNodeService.isLocalNode()) {
      // This device is the Local Node: execute locally.
      syncLogger.info("LocalNodeTransport", "Executing on local node (self)", {
        command_type: command.command_type,
        command_id: command.command_id,
      });
      const event = await localNodeService.handleNodeCommand(command);
      syncLogger.transport(this, "completed", {
        command_type: command.command_type,
        event_type: event?.event_type,
      });
      return event ? [event] : [];
    }

    // Client: send command to the Local Node.
    const client = localNodeService.getClient();
    if (!client) {
      throw new Error("LocalNodeTransport: no client connected to Local Node");
    }

    syncLogger.info("LocalNodeTransport", "Sending command to Local Node", {
      command_type: command.command_type,
      command_id: command.command_id,
      node_device_id: localNodeService.getElectedNode()?.deviceId,
    });
    const events = await client.execute(command);
    syncLogger.transport(this, "completed", {
      command_type: command.command_type,
      event_count: events.length,
    });
    return events;
  }
}

export const localNodeTransport = new LocalNodeTransport();
