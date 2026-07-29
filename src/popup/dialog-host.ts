/**
 * Single-open dialog policy for the extension popup.
 *
 * Opening one dialog closes every other open dialog. Pure helpers stay free of
 * DOM so unit tests can drive the real policy without a browser.
 */

/**
 * Which open dialogs should close when `openingId` becomes the sole open dialog.
 */
export function dialogsToCloseWhenOpening(openIds: Iterable<string>, openingId: string): string[] {
  const toClose: string[] = [];
  for (const id of openIds) {
    if (id !== openingId) {
      toClose.push(id);
    }
  }
  return toClose;
}

/**
 * Mutable set of open dialog ids with single-open semantics.
 * DOM side effects stay in the caller so this module stays pure/testable.
 */
export class PopupDialogHost<Id extends string = string> {
  private readonly openIds = new Set<Id>();

  isOpen(id: Id): boolean {
    return this.openIds.has(id);
  }

  anyOpen(): boolean {
    return this.openIds.size > 0;
  }

  listOpen(): Id[] {
    return [...this.openIds];
  }

  /**
   * Transition `id` to open. Returns other ids that must be closed by the caller.
   * No-ops (empty array + alreadyOpen true) when `id` was already open.
   */
  markOpen(id: Id): { alreadyOpen: boolean; closedIds: Id[] } {
    if (this.openIds.has(id)) {
      return { alreadyOpen: true, closedIds: [] };
    }
    const closedIds = dialogsToCloseWhenOpening(this.openIds, id) as Id[];
    for (const other of closedIds) {
      this.openIds.delete(other);
    }
    this.openIds.add(id);
    return { alreadyOpen: false, closedIds };
  }

  /**
   * Transition `id` to closed. Returns whether it was open.
   */
  markClose(id: Id): boolean {
    return this.openIds.delete(id);
  }

  /** Clear all open ids (e.g. Escape closes the active dialog after DOM hide). */
  markCloseAll(): Id[] {
    const ids = [...this.openIds];
    this.openIds.clear();
    return ids;
  }
}
