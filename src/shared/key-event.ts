/**
 * Privacy-safe keyboard event labeling — re-exported from the core.
 *
 * Moved to `packages/replay-core/src/capture/key-event.ts` so the browser SDK
 * applies the same allowlist: named keys and modifier shortcuts are recorded,
 * raw typed characters never are. An SDK embedded in a real product would
 * otherwise record passwords typed into that product's own forms.
 */

export * from "../../packages/replay-core/src/capture/key-event";
