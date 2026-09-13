/**
 * Local Node store — platform-agnostic, core-owned.
 * Mesh mode: no elected node, every isLocalNodeEnabled device is both publisher and scanner.
 */

import { getKVDriver } from "../adapters/kv";

export interface DiscoveredNode {
  deviceId: string;
  name: string;
  host: string;
  port: number;
  deviceName?: string;
  lastSeenAt: string;
}

export interface ConnectedClient {
  deviceId: string;
  deviceName?: string;
  host?: string;
  connectedAt: string;
}

interface LocalNodeState {
  isLocalNodeEnabled: boolean;
  localNodePort: number;
  discoveredNodes: DiscoveredNode[];
  connectedClients: ConnectedClient[];
}

const DEFAULT_PORT = 44621;
const KV_KEY = "teinc_local_node";

type Listener = (state: LocalNodeState, prev: LocalNodeState) => void;

class LocalNodeStore {
  private state: LocalNodeState = {
    isLocalNodeEnabled: false,
    localNodePort: DEFAULT_PORT,
    discoveredNodes: [],
    connectedClients: [],
  };
  private listeners = new Set<Listener>();

  constructor() {
    this.hydrate();
  }

  private hydrate(): void {
    try {
      const ls = typeof localStorage !== "undefined" ? localStorage.getItem(KV_KEY) : null;
      if (ls) {
        const parsed = JSON.parse(ls) as Partial<LocalNodeState>;
        this.state = { ...this.state, ...parsed, discoveredNodes: [], connectedClients: [] };
        return;
      }
      const old = typeof localStorage !== "undefined" ? localStorage.getItem("local_node_data") : null;
      if (old) {
        try {
          const parsedOld = JSON.parse(old) as { state?: Partial<LocalNodeState> } | Partial<LocalNodeState>;
          const p = (parsedOld as { state?: Partial<LocalNodeState> }).state ?? (parsedOld as Partial<LocalNodeState>);
          if (p && typeof p.isLocalNodeEnabled === "boolean") {
            this.state = { ...this.state, ...p, discoveredNodes: [], connectedClients: [] };
            return;
          }
        } catch {}
      }
    } catch {}
    try {
      const kv = getKVDriver();
      const raw = kv?.getItem(KV_KEY) as unknown as string | Promise<string | null> | null;
      if (raw instanceof Promise) {
        raw.then((v) => {
          if (!v) {
            const kv2 = getKVDriver();
            const rawOld = kv2?.getItem("local_node_data") as unknown as string | Promise<string | null> | null;
            if (rawOld instanceof Promise) rawOld.then((o) => { if (!o) return; try { const po = JSON.parse(o) as { state?: Partial<LocalNodeState> }; const p = po.state ?? po; this.state = { ...this.state, ...p, discoveredNodes: [], connectedClients: [] }; const prev = { ...this.state }; for (const l of this.listeners) try { l(this.getState(), prev); } catch {} } catch {} }).catch(() => {});
            else if (rawOld) try { const po = JSON.parse(rawOld as string) as { state?: Partial<LocalNodeState> }; const p = po.state ?? po; this.state = { ...this.state, ...p, discoveredNodes: [], connectedClients: [] }; const prev2 = { ...this.state }; for (const l of this.listeners) try { l(this.getState(), prev2); } catch {} } catch {}
            return;
          }
          try {
            const parsed = JSON.parse(v) as Partial<LocalNodeState>;
            const prev = { ...this.state, discoveredNodes: [...this.state.discoveredNodes], connectedClients: [...this.state.connectedClients] };
            this.state = { ...this.state, ...parsed, discoveredNodes: [], connectedClients: [] };
            for (const l of this.listeners) try { l(this.getState(), prev); } catch {}
          } catch {}
        }).catch(() => {});
      } else if (raw) {
        const parsed = JSON.parse(raw) as Partial<LocalNodeState>;
        this.state = { ...this.state, ...parsed, discoveredNodes: [], connectedClients: [] };
      }
    } catch {}
  }

  async rehydrate(): Promise<void> {
    try {
      const kv = getKVDriver();
      const raw = await kv.getItem(KV_KEY);
      let parsed: Partial<LocalNodeState> | null = null;
      if (raw) {
        try { parsed = JSON.parse(raw) as Partial<LocalNodeState>; } catch {}
      } else {
        try {
          const ls = typeof localStorage !== "undefined" ? localStorage.getItem(KV_KEY) : null;
          if (ls) parsed = JSON.parse(ls) as Partial<LocalNodeState>;
        } catch {}
      }
      if (!parsed) {
        try {
          const oldRaw = await kv.getItem("local_node_data");
          if (oldRaw) {
            const po = JSON.parse(oldRaw as string) as { state?: Partial<LocalNodeState> };
            parsed = (po as { state?: Partial<LocalNodeState> }).state ?? (po as unknown as Partial<LocalNodeState>);
          }
        } catch {}
      }
      if (!parsed) return;
      const prev = { ...this.state, discoveredNodes: [...this.state.discoveredNodes], connectedClients: [...this.state.connectedClients] };
      const next: Partial<LocalNodeState> = {};
      if (typeof parsed.isLocalNodeEnabled === "boolean") next.isLocalNodeEnabled = parsed.isLocalNodeEnabled;
      if (typeof parsed.localNodePort === "number") next.localNodePort = parsed.localNodePort;
      const changed = next.isLocalNodeEnabled !== undefined && next.isLocalNodeEnabled !== this.state.isLocalNodeEnabled;
      this.state = { ...this.state, ...next, discoveredNodes: [], connectedClients: [] };
      if (changed) {
        for (const l of this.listeners) try { l(this.getState(), prev); } catch {}
      }
    } catch {}
  }

  private persist(): void {
    try {
      const kv = getKVDriver();
      if (!kv) return;
      const toSave: Partial<LocalNodeState> = {
        isLocalNodeEnabled: this.state.isLocalNodeEnabled,
        localNodePort: this.state.localNodePort,
      };
      const raw = JSON.stringify(toSave);
      kv.setItem(KV_KEY, raw);
      try { if (typeof localStorage !== "undefined") localStorage.setItem(KV_KEY, raw); } catch {}
    } catch {}
  }

  private set(partial: Partial<LocalNodeState>): void {
    const prev = { ...this.state, discoveredNodes: [...this.state.discoveredNodes], connectedClients: [...this.state.connectedClients] };
    this.state = { ...this.state, ...partial };
    this.persist();
    for (const l of this.listeners) {
      try { l(this.getState(), prev); } catch {}
    }
  }

  getState(): LocalNodeState & {
    setIsLocalNodeEnabled: (v: boolean) => void;
    setLocalNodePort: (p: number) => void;
    addDiscoveredNode: (n: DiscoveredNode) => void;
    removeDiscoveredNode: (id: string) => void;
    clearDiscoveredNodes: () => void;
    addConnectedClient: (c: ConnectedClient) => void;
    removeConnectedClient: (id: string) => void;
    clearConnectedClients: () => void;
  } {
    const self = this;
    return {
      ...this.state,
      setIsLocalNodeEnabled: (enabled: boolean) => self.set({ isLocalNodeEnabled: enabled }),
      setLocalNodePort: (port: number) => self.set({ localNodePort: port }),
      addDiscoveredNode: (node: DiscoveredNode) => {
        const prev = { ...self.state, discoveredNodes: [...self.state.discoveredNodes] };
        // Dedup by deviceId (same peer re-announced) OR by host:port
        // (TCP sweep's synthetic "lan-X.X.X.X" vs mDNS real UUID for same device).
        const existingById = self.state.discoveredNodes.find((n) => n.deviceId === node.deviceId);
        const existingByAddr = !existingById && node.host && node.port
          ? self.state.discoveredNodes.find((n) => n.host === node.host && n.port === node.port)
          : undefined;
        const existing = existingById ?? existingByAddr;
        if (existing) {
          // Prefer the real UUID entry over synthetic "lan-" prefix entries
          const keep = (existing.deviceId.startsWith("lan-") && !node.deviceId.startsWith("lan-"))
            ? node : existing;
          self.state = {
            ...self.state,
            discoveredNodes: self.state.discoveredNodes.map((n) =>
              (n.deviceId === keep.deviceId || n.host === keep.host && n.port === keep.port)
                ? { ...n, ...keep, lastSeenAt: new Date().toISOString() }
                : n
            ),
          };
        } else {
          self.state = { ...self.state, discoveredNodes: [...self.state.discoveredNodes, { ...node, lastSeenAt: new Date().toISOString() }] };
        }
        for (const l of self.listeners) { try { l(self.getState(), prev); } catch {} }
      },
      removeDiscoveredNode: (deviceId: string) => {
        const prev = { ...self.state, discoveredNodes: [...self.state.discoveredNodes] };
        self.state = { ...self.state, discoveredNodes: self.state.discoveredNodes.filter((n) => n.deviceId !== deviceId) };
        for (const l of self.listeners) { try { l(self.getState(), prev); } catch {} }
      },
      clearDiscoveredNodes: () => self.set({ discoveredNodes: [] }),
      addConnectedClient: (client: ConnectedClient) => {
        const prev = { ...self.state, connectedClients: [...self.state.connectedClients] };
        const existing = self.state.connectedClients.find((c) => c.deviceId === client.deviceId);
        if (existing) {
          self.state = {
            ...self.state,
            connectedClients: self.state.connectedClients.map((c) => (c.deviceId === client.deviceId ? { ...c, ...client } : c)),
          };
        } else {
          self.state = { ...self.state, connectedClients: [...self.state.connectedClients, client] };
        }
        for (const l of self.listeners) { try { l(self.getState(), prev); } catch {} }
      },
      removeConnectedClient: (deviceId: string) => {
        const prev = { ...self.state, connectedClients: [...self.state.connectedClients] };
        self.state = { ...self.state, connectedClients: self.state.connectedClients.filter((c) => c.deviceId !== deviceId) };
        for (const l of self.listeners) { try { l(self.getState(), prev); } catch {} }
      },
      clearConnectedClients: () => self.set({ connectedClients: [] }),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _reset(): void {
    this.state = {
      isLocalNodeEnabled: false,
      localNodePort: DEFAULT_PORT,
      discoveredNodes: [],
      connectedClients: [],
    };
    this.listeners.clear();
  }
}

export const localNodeStore = new LocalNodeStore();

import * as React from "react";

export function useLocalNodeStore(): ReturnType<LocalNodeStore["getState"]>;
export function useLocalNodeStore<T>(selector: (s: ReturnType<LocalNodeStore["getState"]>) => T): T;
export function useLocalNodeStore<T>(selector?: (s: ReturnType<LocalNodeStore["getState"]>) => T): T | ReturnType<LocalNodeStore["getState"]> {
  const [state, setState] = React.useState<ReturnType<LocalNodeStore["getState"]>>(() => localNodeStore.getState());
  React.useEffect(() => {
    const unsub = localNodeStore.subscribe((next) => setState(next as ReturnType<LocalNodeStore["getState"]>));
    setState(localNodeStore.getState());
    return unsub;
  }, []);
  if (selector) return selector(state);
  return state as unknown as T;
}
(useLocalNodeStore as unknown as { getState: () => ReturnType<LocalNodeStore["getState"]>; subscribe: (fn: (s: LocalNodeState, p: LocalNodeState) => void) => () => void }).getState = () => localNodeStore.getState();
(useLocalNodeStore as unknown as { getState: () => ReturnType<LocalNodeStore["getState"]>; subscribe: (fn: (s: LocalNodeState, p: LocalNodeState) => void) => () => void }).subscribe = (fn) => localNodeStore.subscribe(fn);
