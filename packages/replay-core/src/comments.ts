/**
 * Comments attached to a recording.
 *
 * For mailbox replays the comments live server-side (the replay URL is the
 * capability — anyone holding it may read and post). For Drive/Dropbox
 * replays the player keeps them in localStorage under the same shape, so the
 * two paths share one model.
 */

export interface GnComment {
  /** Random id assigned by the store. */
  id: string;
  /** Display name the commenter typed; empty means "Anonymous". */
  author: string;
  body: string;
  /** Recording position the comment refers to, if the commenter pinned one. */
  atMs?: number;
  /** ISO timestamp of creation. */
  createdAt: string;
}

export const MAX_COMMENT_AUTHOR_CHARS = 80;
export const MAX_COMMENT_BODY_CHARS = 4_000;
export const MAX_COMMENTS_PER_RECORDING = 200;

/** Normalize arbitrary input into a comment, or null when unusable. */
export function normalizeComment(input: unknown, makeId: () => string): GnComment | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body || body.length > MAX_COMMENT_BODY_CHARS) {
    return null;
  }
  const comment: GnComment = {
    id: makeId(),
    author:
      typeof raw.author === "string" ? raw.author.trim().slice(0, MAX_COMMENT_AUTHOR_CHARS) : "",
    body,
    createdAt: new Date().toISOString(),
  };
  if (typeof raw.atMs === "number" && Number.isFinite(raw.atMs) && raw.atMs >= 0) {
    comment.atMs = Math.round(raw.atMs);
  }
  return comment;
}

/** Markdown export of a comment thread (used by issue bodies and exports). */
export function renderCommentsMarkdown(comments: GnComment[]): string {
  if (comments.length === 0) {
    return "";
  }
  const lines = ["## Comments", ""];
  for (const comment of comments) {
    const who = comment.author || "Anonymous";
    const at = comment.atMs !== undefined ? ` @${Math.round(comment.atMs / 1000)}s` : "";
    lines.push(`- **${who}** (${comment.createdAt}${at}): ${comment.body}`);
  }
  lines.push("");
  return lines.join("\n");
}
