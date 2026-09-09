/**
 * Local Node adapters — platform drivers implement these.
 */

import type { Command, DomainEvent } from "../sync/types";
import type { ReferenceDataKey, ReferenceDataRecord } from "../reference/types";
import type { DiscoveredNode } from "./store";

export interface DiscoveryAdapter {
  setOptions(opts: {
    deviceId: string;
    deviceName?: string;
    onNodeFound: (node: DiscoveredNode) => void;
    onNodeLost: (deviceId: string) => void;
  }): void;
  startScanning(): void;
  stopScanning(): void;
  startPublishing(opts: {
    deviceId: string;
    deviceName?: string;
    port: number;
    onNodeFound: (node: DiscoveredNode) => void;
    onNodeLost: (deviceId: string) => void;
  }): void;
  stop(): void;
}

export interface LocalNodeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
  broadcast(event: DomainEvent): void;
}

export interface LocalNodeClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  execute(command: Command): Promise<DomainEvent[]>;
  requestReferenceData(
    businessId: string,
    keys: ReferenceDataKey[],
  ): Promise<{ data: Partial<Record<ReferenceDataKey, ReferenceDataRecord | null>> }>;
  publishEvent?(event: DomainEvent): Promise<void> | void;
}

export interface TransportAdapter {
  createServer(opts: {
    port: number;
    businessId: string;
    secret: string;
    onCommand: (command: Command) => Promise<DomainEvent[]>;
    onRelayEvent: (event: DomainEvent) => void;
    onClientConnected: (info: { deviceId: string; deviceName?: string; host?: string }) => void;
    onClientDisconnected: (deviceId: string) => void;
  }): LocalNodeServer;
  createClient(opts: {
    node: { deviceId: string; host: string; port: number };
    businessId: string;
    secret: string;
    onEvent: (event: DomainEvent) => void;
    onConnected: () => void;
    onDisconnected: () => void;
    onError: (error: unknown) => void;
  }): LocalNodeClient;
}

export interface KeepAliveAdapter {
  activate(tag: string): Promise<void>;
  deactivate(tag: string): Promise<void>;
}

export interface LocalNodeDeps {
  getDeviceId: () => string | Promise<string>;
  getDeviceName?: () => string | undefined;
  getBusiness: () => { id: string; ownerId?: string; owner_id?: string } | null;
  getAuth: () => { user: unknown | null; accessToken: string | null };
  discovery: DiscoveryAdapter;
  transport: TransportAdapter;
  keepAlive?: KeepAliveAdapter;
  cloudCommandTimeoutMs?: number;
}
