import { phoenixSocket } from "./phoenix-socket";
import { syncLogger } from "../utils/sync-logger";

type EventCallback = (event: Record<string, unknown>) => void;

class EventsService {
  private refCount = 0;
  private topic: string | null = null;
  private joined = false;
  /**
   * Last event sequence per business. The backend sequence is global, but the
   * watermark is kept per business so switching business (or account) never
   * inherits — and therefore never skips — the other scope's events.
   */
  private sequences = new Map<string, number>();
  private lastSequence = 0;
  private activeBusinessId: string | null = null;
  private activeUserId: string | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private wildcardListeners: Set<EventCallback> = new Set();
  private frameHandlerUnsub: (() => void) | null = null;

  private currentSequence(): number {
    if (this.activeBusinessId) return this.sequences.get(this.activeBusinessId) ?? 0;
    return this.lastSequence;
  }

  private setCurrentSequence(sequence: number): void {
    if (this.activeBusinessId) this.sequences.set(this.activeBusinessId, sequence);
    else this.lastSequence = sequence;
  }

  connect(userId: string, businessId?: string | null): () => void {
    this.refCount++;
    const topic = `events:${userId}`;
    if (businessId !== undefined) this.activeBusinessId = businessId ?? null;

    if (this.refCount === 1 && !this.frameHandlerUnsub) {
      this.topic = topic;
      // A different account has a different authorization scope: sequences
      // from the previous account are not comparable, so start clean.
      if (this.activeUserId !== userId) {
        this.activeUserId = userId;
        this.sequences.clear();
        this.lastSequence = 0;
      }
      this.frameHandlerUnsub = phoenixSocket.onFrame(topic, ([_joinRef, _ref, _topic, event, payload]) => {
        const data = payload as Record<string, unknown>;
        const payloadBid = data?.business_id as string | undefined;
        if (this.activeBusinessId && payloadBid && payloadBid !== this.activeBusinessId) return;
        const sequence = data?._sequence;
        const last = this.currentSequence();
        if (typeof sequence === "number" && sequence <= last) return;
        if (typeof sequence === "number") this.setCurrentSequence(sequence);
        else if (typeof data?._sequence === "number") this.setCurrentSequence(data._sequence as number);
        // Business-state frames are LOUD (info): when live updates stall,
        // these lines prove whether the backend pushed anything at all.
        if (
          event.startsWith("order.") ||
          event.startsWith("delivery.") ||
          event.startsWith("payment.") ||
          event === "reference_data.changed"
        ) {
          try {
            syncLogger.info("EventsService", "Phoenix event received", {
              topic,
              event,
              order_id: (data?.order_id as string | undefined) ?? (data?.id as string | undefined),
              business_id: payloadBid,
            });
          } catch {}
        }
        const typeListeners = this.listeners.get(event);
        if (typeListeners) typeListeners.forEach((cb) => cb(data));
        this.wildcardListeners.forEach((cb) => cb(data));
      });

      const joinPayload: Record<string, unknown> = {};
      const joinSequence = this.currentSequence();
      if (joinSequence > 0) joinPayload.last_sequence = joinSequence;
      if (this.activeBusinessId) joinPayload.business_id = this.activeBusinessId;

      phoenixSocket
        .connect()
        .then(() => phoenixSocket.joinChannel(topic, joinPayload))
        .then(() => {
          this.joined = true;
          try {
            syncLogger.info("EventsService", "Phoenix channel joined", {
              topic,
              business_id: this.activeBusinessId,
            });
          } catch {}
        })
        .catch((e) => {
          // A failed join previously vanished into a swallowed rejection:
          // socket "connected" but subscribed to nothing. Loud from now on.
          try {
            syncLogger.warn("EventsService", "Phoenix channel join failed", {
              topic,
              error: String(e),
            });
          } catch {}
        });
    } else if (businessId !== undefined) {
      // business switched while already joined — update filter without rejoin (next events filtered). If backend requires business:{id} subscription, re-join could be forced — not needed as fallback business_authorized check still passes.
      this.activeBusinessId = businessId ?? null;
    }

    let disconnected = false;
    return () => {
      if (disconnected) return; disconnected = true;
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) {
        if (this.topic && this.joined) phoenixSocket.leaveChannel(this.topic);
        this.frameHandlerUnsub?.(); this.frameHandlerUnsub = null; this.joined = false; this.topic = null;
        // reset sequence on full disconnect so next user doesn't dedup? Keep until next connect with same user - if user changes, lastSequence should reset. Caller should ensure new userId -> new instance or reset.
        // Keep for replay.
      }
    };
  }

  on(eventType: string, callback: EventCallback): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(callback);
    return () => { this.listeners.get(eventType)?.delete(callback); };
  }

  onAny(callback: EventCallback): () => void { this.wildcardListeners.add(callback); return ()=> this.wildcardListeners.delete(callback); }

  isConnected(): boolean { return this.joined && phoenixSocket.isConnected(); }

  resetSequence(): void {
    this.lastSequence = 0;
    this.sequences.clear();
  }
}

export const eventsService = new EventsService();
