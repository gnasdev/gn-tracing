/**
 * Shared privacy policy and redaction helpers — re-exported from the core.
 *
 * The implementation moved to `packages/replay-core/src/redact/` so the
 * browser SDK applies byte-for-byte the same policy as the extension. Of
 * everything shared between producers this matters most: two implementations of
 * redaction means two definitions of what counts as sensitive, and the weaker
 * one decides what leaks.
 *
 * This file stays so the service worker, content script, and settings page keep
 * their existing import path.
 */

export * from "../../packages/replay-core/src/redact/privacy-redaction";
