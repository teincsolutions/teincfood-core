/**
 * Durable command queue — states queued/processing/succeeded/retryable/permanent (§21).
 * Canonical in src/sync/command-queue.service.
 */
export { commandQueueService, getQueuedStatus } from "../command-queue.service";
