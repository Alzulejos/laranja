/**
 * Wire format and key names for the local (`laranja dev`) queue implementation.
 *
 * Lives in core because two packages have to agree on it exactly: the producer
 * in laranja-decorators (`getQueue().send()`) writes these keys, and the local
 * poller reads them. A drift between the two is a silently lost message, so
 * there is one definition and both import it.
 *
 * Backed by the Redis a project already declares — logical database
 * `REDIS_DB_QUEUE`, never the cache's — so local queues need no broker of their
 * own. The semantics deliberately mirror SQS (visibility timeout, receive count,
 * delay, dead-letter after N receives) because laranja's queue vocabulary in
 * `QueueTuning` is already SQS-shaped; Azure is the model we translate into, not
 * the one we are built on.
 */

/** Env var holding the Redis URL the local queue uses. Written by `laranja dev`. */
export const LOCAL_QUEUE_URL_ENV = "LARANJA_QUEUE_REDIS_URL";

/** The value of `PROVIDER_ENV_NAME` that selects the local implementation. */
export const LOCAL_PROVIDER = "local";

/** One message as it sits in Redis. */
export interface LocalQueueMessage {
  /** Stable id, surfaced to the consumer as the SQS `messageId`. */
  id: string;
  /** The body exactly as the producer serialized it — always a string, as on SQS. */
  body: string;
  /** How many times this message has been delivered. Drives dead-lettering. */
  receiveCount: number;
  /** Epoch ms the message was first enqueued. */
  enqueuedAt: number;
}

/** Ready messages, oldest at the tail (RPOP end). */
export function localQueueKey(name: string): string {
  return `laranja:queue:${name}`;
}

/** Sorted set of not-yet-visible messages, scored by the epoch ms they become visible. */
export function localDelayedKey(name: string): string {
  return `laranja:queue:${name}:delayed`;
}

/**
 * Sorted set of in-flight messages, scored by the epoch ms their visibility
 * timeout expires — the local equivalent of SQS holding a received message
 * hidden until the consumer either succeeds or the timeout returns it.
 */
export function localInflightKey(name: string): string {
  return `laranja:queue:${name}:inflight`;
}
