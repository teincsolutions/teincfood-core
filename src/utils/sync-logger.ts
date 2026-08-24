/**
 * Structured logging for the Sync Engine, commands, events, and transports.
 *
 * Logs are sent to console.debug in debug builds. In production this can be
 * swapped for a crashlytics/analytics sink without changing call sites.
 */

import type { Command, DomainEvent, Transport } from "../sync/types";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  namespace: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

function emit(entry: LogEntry): void {
  const { level, namespace, message, data } = entry;
  const tag = `[${namespace}] ${message}`;
  switch (level) {
    case "debug":
      console.debug(tag, data);
      break;
    case "info":
      console.info(tag, data);
      break;
    case "warn":
      console.warn(tag, data);
      break;
    case "error":
      console.error(tag, data);
      break;
  }
}

declare const __DEV__: boolean | undefined;

class SyncLogger {
  private enabled: boolean;

  constructor() {
    try {
      this.enabled = typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production";
    } catch {
      this.enabled = process.env.NODE_ENV !== "production";
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private log(
    level: LogLevel,
    namespace: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;
    emit({
      level,
      namespace,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  debug = (namespace: string, message: string, data?: Record<string, unknown>) =>
    this.log("debug", namespace, message, data);
  info = (namespace: string, message: string, data?: Record<string, unknown>) =>
    this.log("info", namespace, message, data);
  warn = (namespace: string, message: string, data?: Record<string, unknown>) =>
    this.log("warn", namespace, message, data);
  error = (namespace: string, message: string, data?: Record<string, unknown>) =>
    this.log("error", namespace, message, data);

  command(command: Command, action: "issued" | "queued" | "executing" | "completed" | "failed", data?: Record<string, unknown>): void {
    this.debug("SyncEngine:Command", `Command ${action}`, {
      command_id: command.command_id,
      command_type: command.command_type,
      business_id: command.business_id,
      entity_id: command.entity_id,
      ...data,
    });
  }

  event(event: DomainEvent, action: "received" | "persisted" | "applied" | "broadcast", data?: Record<string, unknown>): void {
    this.debug("SyncEngine:Event", `Event ${action}`, {
      event_id: event.event_id,
      event_type: event.event_type,
      entity_id: event.entity_id,
      ...data,
    });
  }

  transport(transport: Pick<Transport, "name">, action: "available" | "unavailable" | "executing" | "completed" | "error", data?: Record<string, unknown>): void {
    this.debug("SyncEngine:Transport", `Transport ${action}`, {
      transport: transport.name,
      ...data,
    });
  }
}

export const syncLogger = new SyncLogger();
