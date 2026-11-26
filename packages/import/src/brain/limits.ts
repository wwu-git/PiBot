// Kept free of imports: adapters and the adapter registry import each other, and constants read
// at module load must not depend on that cycle's evaluation order.

/** A topic message keeps at most this much text; anything longer is a "long message". */
export const MESSAGE_CHARS = 65_536;
/** A long message is read whole up to the record limit, then saved as a text attachment. */
export const LONG_MESSAGE_CHARS = 8 * 1024 * 1024;
