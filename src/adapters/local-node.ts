/**
 * Local Node adapters — re-export core-owned implementation for compat.
 * Host apps should import from @teincfood/core/local-node instead.
 */

import type { Command, DomainEvent } from "../sync/types";
import { localNodeService as coreService } from "../local-node/service";
import { localNodeStore, useLocalNodeStore as coreStore } from "../local-node/store";
import type { LocalNodeClient as CoreClient } from "../local-node/adapters";

export type LocalNodeClient = CoreClient;
export interface ElectedNode { deviceId: string; }

export function setLocalNodeState(s: {
  isLocalNodeEnabled?: boolean;
  isConnectedToNode?: boolean;
  isLocalNode?: boolean;
  electedNode?: ElectedNode | null;
  client?: LocalNodeClient | null;
}): void {
  // Compat: no-op — core store/service is source of truth.
  // Business/Desktop bootstrap now calls initLocalNodeService(deps).
  void s;
}

export const localNodeService = coreService as unknown as {
  isLocalNode: () => boolean;
  isConnectedToNode: () => boolean;
  getElectedNode: () => ElectedNode | null;
  getClient: () => LocalNodeClient | null;
  broadcastToClients: (_event: DomainEvent) => void;
  handleNodeCommand: (_command: Command) => Promise<DomainEvent | null>;
};

export const useLocalNodeStore = coreStore as unknown as {
  getState: () => {
    isLocalNodeEnabled: boolean;
    isConnectedToNode: boolean;
    electedNode: ElectedNode | null;
  };
};
