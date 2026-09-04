import { WS_BASE_URL } from "../utils/constants";
import { getAuthToken } from "../adapters/auth";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
export type PhoenixV2Frame = [string | null, string | null, string, string, Record<string, unknown>];
export type PhoenixOutbound = { topic: string; event: string; payload: Record<string, unknown>; ref?: string | null; joinRef?: string | null };
type FrameHandler = (frame: PhoenixV2Frame) => void;

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 10000;
const HEARTBEAT_MS = 30000;

class PhoenixSocket {
  socket: WebSocket | null = null;
  private refCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPend = false;
  private heartbeatMissed = 0;
  private static readonly MAX_MISSED = 3;
  private intentionalClose = false;
  private connectGen = 0;
  private connectPromise: Promise<void> | null = null;
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners: Set<(s: ConnectionState) => void> = new Set();
  private pendingJoins: Map<string, { resolve: (p: Record<string, unknown>) => void; reject: (e: Error) => void }> = new Map();
  private pendingPushes: Map<string, { resolve: (p: Record<string, unknown>) => void; reject: (e: Error) => void }> = new Map();
  joinedChannels: Set<string> = new Set();
  private pendingRejoin: Set<string> = new Set();
  private topicJoinRefs: Map<string, string> = new Map();
  private frameHandlers: Map<string, Set<FrameHandler>> = new Map();

  private getRef(): string { return String(++this.refCounter); }

  private buildSocketUrl(token: string): string {
    const base = WS_BASE_URL.replace(/\/+$/, "");
    const path = base.endsWith("/ws") ? "/websocket" : "/ws/websocket";
    return `${base}${path}?token=${encodeURIComponent(token)}&vsn=2.0.0`;
  }

  private setState(s: ConnectionState) {
    this.connectionState = s;
    this.connectionListeners.forEach((fn) => fn(s));
  }

  onConnectionStateChange(fn: (s: ConnectionState) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  getConnectionState(): ConnectionState { return this.connectionState; }

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.cancelReconnect();
    this.intentionalClose = false;
    this.setState("connecting");
    this.connectPromise = new Promise((resolve, reject) => {
      const token = getAuthToken();
      if (!token) { this.setState("disconnected"); this.connectPromise = null; reject(new Error("Not authenticated")); return; }
      const myGen = ++this.connectGen;
      const url = this.buildSocketUrl(token);
      this.socket = new WebSocket(url);
      this.socket.onopen = () => {
        if (myGen !== this.connectGen) return;
        this.reconnectAttempt = 0; this.setState("connected"); this.startHeartbeat(); this.rejoinPending().catch(()=>{}); this.connectPromise = null; resolve();
      };
      this.socket.onerror = () => { if (myGen !== this.connectGen) return; if (this.connectionState === "connecting") { this.setState("disconnected"); this.connectPromise = null; } };
      this.socket.onmessage = (ev) => { try { const frame: PhoenixV2Frame = JSON.parse(ev.data); this.handleFrame(frame); } catch {} };
      this.socket.onclose = () => {
        if (myGen !== this.connectGen) return;
        this.stopHeartbeat();
        if (!this.intentionalClose) { this.joinedChannels.forEach((t)=> this.pendingRejoin.add(t)); this.joinedChannels.clear(); this.scheduleReconnect(); }
        else { this.joinedChannels.clear(); this.pendingRejoin.clear(); this.setState("disconnected"); }
        this.connectPromise = null;
      };
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.intentionalClose = true; this.cancelReconnect(); this.stopHeartbeat();
    this.joinedChannels.clear(); this.pendingRejoin.clear(); this.pendingJoins.clear(); this.pendingPushes.clear(); this.topicJoinRefs.clear(); this.frameHandlers.clear();
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.setState("disconnected"); this.connectPromise = null;
  }

  retryConnection(): void { this.cancelReconnect(); this.reconnectAttempt = 0; this.connect().catch(()=>{}); }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.setState("reconnecting");
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(()=> this.connect().catch(()=>{}), delay);
  }

  private cancelReconnect(): void { if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; } }

  private startHeartbeat(): void {
    this.heartbeatPend = false; this.heartbeatMissed = 0;
    this.heartbeatTimer = setInterval(()=> {
      if (this.heartbeatPend) { this.heartbeatMissed++; if (this.heartbeatMissed >= PhoenixSocket.MAX_MISSED) this.socket?.close(); return; }
      this.heartbeatPend = true; this.sendRaw({ topic: "phoenix", event: "heartbeat", payload: {} });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } this.heartbeatPend = false; this.heartbeatMissed = 0; }

  private sendRaw(msg: PhoenixOutbound): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      const joinRef = msg.topic && msg.topic !== "phoenix" ? (msg.joinRef ?? this.topicJoinRefs.get(msg.topic) ?? null) : (msg.joinRef ?? null);
      const frame: PhoenixV2Frame = [joinRef, msg.ref ?? null, msg.topic, msg.event, msg.payload];
      this.socket.send(JSON.stringify(frame));
    }
  }

  push(topic: string, event: string, payload: Record<string, unknown>): void { const ref = this.getRef(); this.sendRaw({ topic, event, payload, ref, joinRef: this.topicJoinRefs.get(topic) }); }

  pushWithReply(topic: string, event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ref = this.getRef(); const msg: PhoenixOutbound = { topic, event, payload, ref, joinRef: this.topicJoinRefs.get(topic) };
    return new Promise((resolve, reject)=> {
      this.pendingPushes.set(ref, { resolve, reject });
      this.sendRaw(msg);
      setTimeout(()=> { if (this.pendingPushes.has(ref)) { this.pendingPushes.delete(ref); reject(new Error(`Request timed out: ${event} on ${topic}`)); } }, 5000);
    });
  }

  private handleFrame([joinRef, ref, topic, event, payload]: PhoenixV2Frame): void {
    if (event === "phx_reply" && topic === "phoenix") { this.heartbeatPend = false; this.heartbeatMissed = 0; return; }
    if (event === "phx_reply" && ref) {
      const pending = this.pendingPushes.get(ref);
      if (pending) {
        const status = (payload as Record<string, unknown>)?.status;
        const response = ((payload as Record<string, unknown>)?.response ?? {}) as Record<string, unknown>;
        if (status === "ok") pending.resolve(response); else pending.reject(new Error(String((response as Record<string, unknown>).reason ?? "Request failed")));
        this.pendingPushes.delete(ref); return;
      }
    }
    if (event === "phx_reply" && (payload as Record<string, unknown>)?.status === "ok") {
      const pending = this.pendingJoins.get(topic);
      if (pending) { const response = (((payload as Record<string, unknown>)?.response ?? {}) as Record<string, unknown>); pending.resolve(response); this.pendingJoins.delete(topic); this.joinedChannels.add(topic); if (joinRef) this.topicJoinRefs.set(topic, joinRef); }
      return;
    }
    if (event === "phx_reply" && (payload as Record<string, unknown>)?.status === "error") {
      const pending = this.pendingJoins.get(topic);
      if (pending) { const response = (((payload as Record<string, unknown>)?.response ?? {}) as Record<string, unknown>); pending.reject(new Error(String((response as Record<string, unknown>).reason ?? "Join failed"))); this.pendingJoins.delete(topic); }
      return;
    }
    const handlers = this.frameHandlers.get(topic);
    if (handlers) handlers.forEach((cb)=> cb([joinRef, ref, topic, event, payload as Record<string, unknown>] as unknown as PhoenixV2Frame));
  }

  onFrame(topic: string, handler: FrameHandler): () => void {
    if (!this.frameHandlers.has(topic)) this.frameHandlers.set(topic, new Set());
    this.frameHandlers.get(topic)!.add(handler);
    return () => { this.frameHandlers.get(topic)?.delete(handler); };
  }

  async joinChannel(topic: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.joinedChannels.has(topic)) return Promise.resolve({});
    if (this.pendingJoins.has(topic)) return new Promise((resolve, reject)=> { this.pendingJoins.set(topic, { resolve, reject }); });
    const ref = this.getRef(); const msg: PhoenixOutbound = { topic, event: "phx_join", payload, ref };
    return new Promise((resolve, reject)=> {
      this.pendingJoins.set(topic, { resolve, reject });
      this.sendRaw(msg);
      setTimeout(()=> { if (this.pendingJoins.has(topic)) { this.pendingJoins.delete(topic); reject(new Error(`Failed to join channel ${topic} - timeout`)); } }, 5000);
    });
  }

  leaveChannel(topic: string): void { this.joinedChannels.delete(topic); this.pendingRejoin.delete(topic); this.topicJoinRefs.delete(topic); }

  private async rejoinPending(): Promise<void> { const topics = Array.from(this.pendingRejoin); this.pendingRejoin.clear(); await Promise.allSettled(topics.map((t)=> this.joinChannel(t))); }

  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  hasJoined(topic: string): boolean { return this.joinedChannels.has(topic); }
}

export const phoenixSocket = new PhoenixSocket();
