/**
 * Types for the Local Node / multi-terminal LAN layer.
 */

import type { Command, DomainEvent } from "../sync/types";
import type { ReferenceDataKey, ReferenceDataRecord } from "../reference/types";

export type LocalNodeMessageType =
  | "command"
  | "command_response"
  | "event"
  | "relay_event"
  | "ping"
  | "pong"
  | "hello"
  | "challenge"
  | "auth"
  | "auth_ok"
  | "auth_fail"
  | "register"
  | "register_ack"
  | "reference_fetch"
  | "reference_response";

export interface LocalNodeMessage {
  type: LocalNodeMessageType;
  id: string;
  payload: unknown;
}

export interface LocalNodeCommandMessage extends LocalNodeMessage {
  type: "command";
  payload: Command;
}

export interface LocalNodeCommandResponseMessage extends LocalNodeMessage {
  type: "command_response";
  payload: DomainEvent[];
}

export interface LocalNodeEventMessage extends LocalNodeMessage {
  type: "event";
  payload: DomainEvent;
}

export interface LocalNodeRelayEventMessage extends LocalNodeMessage {
  type: "relay_event";
  payload: DomainEvent;
}

export interface LocalNodeHelloMessage extends LocalNodeMessage {
  type: "hello";
  payload: {
    deviceId: string;
    deviceName?: string;
    businessId?: string;
  };
}

export interface LocalNodeChallengeMessage extends LocalNodeMessage {
  type: "challenge";
  payload: {
    nonce: string;
  };
}

export interface LocalNodeAuthMessage extends LocalNodeMessage {
  type: "auth";
  payload: {
    nonce: string;
    proof: string;
  };
}

export interface LocalNodeAuthOkMessage extends LocalNodeMessage {
  type: "auth_ok";
  payload: Record<string, never>;
}

export interface LocalNodeAuthFailMessage extends LocalNodeMessage {
  type: "auth_fail";
  payload: {
    reason?: string;
  };
}

export interface LocalNodeRegisterMessage extends LocalNodeMessage {
  type: "register";
  payload: {
    deviceId: string;
    deviceName?: string;
    businessId?: string;
    connectedAt: string;
  };
}

export interface LocalNodeRegisterAckMessage extends LocalNodeMessage {
  type: "register_ack";
  payload: Record<string, never>;
}

export interface LocalNodeReferenceFetchMessage extends LocalNodeMessage {
  type: "reference_fetch";
  payload: {
    businessId: string;
    keys: ReferenceDataKey[];
  };
}

export interface LocalNodeReferenceResponseMessage extends LocalNodeMessage {
  type: "reference_response";
  payload: {
    data: Partial<Record<ReferenceDataKey, ReferenceDataRecord | null>>;
  };
}

export type LocalNodeConnectionState = "disconnected" | "connecting" | "connected";

export interface LocalNodeInfo {
  deviceId: string;
  host: string;
  port: number;
  businessId?: string;
  deviceName?: string;
}
