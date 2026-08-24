/**
 * Core types for the offline-first, event-driven Sync Engine.
 *
 * These types define the contract between:
 *   - UI / Hooks
 *   - Repositories
 *   - Sync Engine
 *   - Transports (REST, Local Node, queued)
 *
 * All timestamps are ISO strings. Monetary amounts remain in minor units.
 */

export interface EventMetadata {
  /** Globally unique event identifier (UUID v4). */
  event_id: string;
  /** Business event type, e.g. "order.created". */
  event_type: string;
  /** Event schema version, e.g. "1.0". */
  event_version: string;
  /** ISO 8601 timestamp when the event was originally emitted. */
  timestamp: string;
  /** Device that produced the event. */
  device_id: string;
  /** User that triggered the event. */
  user_id: string;
  /** ID of the aggregate/entity the event belongs to. */
  entity_id: string;
}

export interface DomainEvent<T = unknown> extends EventMetadata {
  payload: T;
}

export interface CommandMetadata {
  /** Globally unique command identifier (UUID v4). Used for idempotency. */
  command_id: string;
  /** Command type, e.g. "create_order". */
  command_type: string;
  /** Command schema version, e.g. "1.0". */
  command_version: string;
  /** ISO 8601 timestamp when the command was issued. */
  timestamp: string;
  /** Device that issued the command. */
  device_id: string;
  /** User that issued the command. */
  user_id: string;
  /** Business that owns the command. */
  business_id: string;
  /** Aggregate/entity ID the command targets, when applicable. */
  entity_id?: string;
}

export interface Command<T = unknown> extends CommandMetadata {
  payload: T;
}

export type CommandStatus =
  | "pending"
  | "in_flight"
  | "completed"
  | "failed"
  | "cancelled";

export interface PersistedCommand<T = Record<string, unknown>>
  extends Command<T> {
  /** Local database row ID. */
  id: number;
  status: CommandStatus;
  /** Error message if status === "failed". */
  error?: string | null;
  /** Retry count. */
  retry_count: number;
  /** ISO 8601 timestamp of last retry attempt. */
  last_attempted_at?: string | null;
  /** ISO 8601 timestamp when the command was persisted. */
  created_at: string;
  /** ISO 8601 timestamp when the command was last updated. */
  updated_at: string;
}

export interface PersistedEvent<T = Record<string, unknown>>
  extends DomainEvent<T> {
  /** Local database row ID. */
  id: number;
  /** Whether this event originated locally or from cloud/LAN. */
  origin: "local" | "cloud" | "lan";
  /** Whether the event has been synced to the cloud. */
  synced_to_cloud: boolean;
  /** ISO 8601 timestamp when the event was persisted. */
  persisted_at: string;
}

export interface Transport {
  /** Human-readable transport name for logging. */
  readonly name: string;

  /** True if the transport is currently available to accept commands. */
  isAvailable(): boolean;

  /**
   * Execute a command and return resulting domain events.
   * The transport is responsible for network serialization only.
   */
  execute(command: Command): Promise<DomainEvent[]>;

  /**
   * Subscribe to events pushed by the transport.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (event: DomainEvent) => void): () => void;
}

export interface SyncStrategy {
  /** Decide how a command should be handled given current state. */
  resolve(
    command: Command,
    context: {
      isOnline: boolean;
      isCloudReachable: boolean;
      isLocalNodeAvailable: boolean;
      queueDepth: number;
    },
  ): "cloud" | "local_node" | "queue" | "reject";
}
