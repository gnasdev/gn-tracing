/** Worker memory is limited; a package over this must be read locally. */
export const MAX_REMOTE_PACKAGE_BYTES = 24 * 1024 * 1024;
/** One JSON artifact this large would blow the response budget anyway. */
export const MAX_REMOTE_ENTRY_BYTES = 8 * 1024 * 1024;
/** Guards against an oversized request body before it is parsed. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
