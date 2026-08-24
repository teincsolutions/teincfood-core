/**
 * Local Node stubs — minimal interfaces so core compiles without RN.
 * Host apps with LAN support replace these via setters.
 */

import type { Command, DomainEvent } from "../sync/types";

export interface LocalNodeClient {
  execute(command: Command): Promise<DomainEvent[]>;
  publishEvent?(event: DomainEvent): void | Promise<void>;
}

export interface ElectedNode {
  deviceId: string;
}

let isLocalEnabled = false;
let isConnected = false;
let isLocalNodeFlag = false;
let electedNode: ElectedNode | null = null;
let client: LocalNodeClient | null = null;

export function setLocalNodeState(s: {
  isLocalNodeEnabled?: boolean;
  isConnectedToNode?: boolean;
  isLocalNode?: boolean;
  electedNode?: ElectedNode | null;
  client?: LocalNodeClient | null;
}): void {
  if (s.isLocalNodeEnabled !== undefined) isLocalEnabled = s.isLocalNodeEnabled;
  if (s.isConnectedToNode !== undefined) isConnected = s.isConnectedToNode;
  if (s.isLocalNode !== undefined) isLocalNodeFlag = s.isLocalNode;
  if (s.electedNode !== undefined) electedNode = s.electedNode;
  if (s.client !== undefined) client = s.client;
}

export const localNodeService = {
  isLocalNode: () => isLocalNodeFlag,
  isConnectedToNode: () => isConnected,
  getElectedNode: () => electedNode,
  getClient: () => client,
  broadcastToClients: (_event: DomainEvent) => {},
  handleNodeCommand: async (_command: Command): Promise<DomainEvent | null> => null,
};

export const useLocalNodeStore = {
  getState: () => ({
    isLocalNodeEnabled: isLocalEnabled,
    isConnectedToNode: isConnected,
    electedNode,
  }),
};
