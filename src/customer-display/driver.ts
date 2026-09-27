import type { CustomerDisplayModel } from "./model";

export interface CustomerDisplayCapabilities {
  /** True when the platform exposes a usable secondary display mechanism. */
  supported: boolean;
  /** Number of monitors/displays the platform reports (1 = single screen). */
  displays: number;
  /** Human-readable reason when unsupported (for the settings UI). */
  reason?: string;
}

/**
 * Platform-specific presentation of the customer display. The shared POS/model
 * layer never knows whether a driver renders to a Tauri window, an Android
 * `Presentation`, or a future serial customer pole. Drivers are responsible for
 * their own lifecycle and hardware quirks.
 */
export interface CustomerDisplayDriver {
  capabilities(): Promise<CustomerDisplayCapabilities>;
  /** Open/show the secondary presentation. Idempotent. */
  open(): Promise<void>;
  /** Close/hide the secondary presentation. Idempotent. */
  close(): Promise<void>;
  /** Push the latest model to the presentation (fire-and-forget). */
  push(model: CustomerDisplayModel): void;
  /** Subscribe to display topology changes (monitor add/remove). */
  onCapabilitiesChanged(
    cb: (caps: CustomerDisplayCapabilities) => void,
  ): () => void;
}
