/**
 * Legacy Google Drive auth entry. Redirects to the multi-cloud storage-auth page.
 * Kept so old bookmarks and GOOGLE_DRIVE_CONNECT openers still work.
 */
const target = new URL(chrome.runtime.getURL("storage-auth/storage-auth.html"));
target.searchParams.set("provider", "google-drive");
location.replace(target.toString());
