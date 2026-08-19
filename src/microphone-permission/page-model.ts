export const MICROPHONE_PERMISSION_PAGE_REL = "microphone-permission/microphone-permission.html";

export function resolveMicrophonePermissionPageUrl(getURL: (path: string) => string): string {
  return getURL(MICROPHONE_PERMISSION_PAGE_REL);
}
