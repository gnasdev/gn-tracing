/**
 * `@gn-tracing/replay-core/redact` — the privacy policy every producer applies.
 *
 * Redaction runs before an entry is buffered, never at replay time, so a
 * package that reaches storage has already had sensitive values removed. Any
 * new producer must route its captured entries through here.
 */

export * from "./privacy-redaction";
