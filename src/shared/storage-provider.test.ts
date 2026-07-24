/**
 * Unit tests for multi-cloud storage provider ids and replay URL parse/build.
 */
import { describe, expect, it } from "vitest";
import {
  buildCloudFolderOpenUrl,
  buildCloudRemoteOpenUrl,
  buildStorageRecordingPath,
  isStorageProviderId,
  normalizeStorageProviderId,
  parseStorageRecordingRef,
  resolveHistoryProvider,
  STORAGE_PROVIDER_PATH_SEGMENTS,
} from "./storage-provider";

describe("isStorageProviderId / normalizeStorageProviderId", () => {
  it("accepts only google-drive and dropbox", () => {
    expect(isStorageProviderId("google-drive")).toBe(true);
    expect(isStorageProviderId("dropbox")).toBe(true);
    expect(isStorageProviderId("onedrive")).toBe(false);
    expect(isStorageProviderId("s3")).toBe(false);
    expect(isStorageProviderId(null)).toBe(false);
  });

  it("normalizes unknown values to the fallback", () => {
    expect(normalizeStorageProviderId("dropbox")).toBe("dropbox");
    expect(normalizeStorageProviderId("nope")).toBe("google-drive");
    expect(normalizeStorageProviderId("onedrive")).toBe("google-drive");
    expect(normalizeStorageProviderId(undefined, "dropbox")).toBe("dropbox");
  });
});

describe("buildStorageRecordingPath", () => {
  it("emits namespaced /gdrive/<id> for google-drive (new uploads)", () => {
    expect(buildStorageRecordingPath("1AbCdEfGhIjKlMnOp")).toBe("/gdrive/1AbCdEfGhIjKlMnOp");
    expect(buildStorageRecordingPath("1AbCdEfGhIjKlMnOp", "google-drive")).toBe(
      "/gdrive/1AbCdEfGhIjKlMnOp",
    );
  });

  it("emits namespaced paths for dropbox", () => {
    expect(buildStorageRecordingPath("dbxid", "dropbox")).toBe("/dropbox/dbxid");
  });

  it("URI-encodes the file id", () => {
    expect(buildStorageRecordingPath("a/b", "dropbox")).toBe("/dropbox/a%2Fb");
  });

  it("returns empty string for blank file id", () => {
    expect(buildStorageRecordingPath("")).toBe("");
    expect(buildStorageRecordingPath("   ")).toBe("");
  });

  it("maps every StorageProviderId to a path segment", () => {
    expect(STORAGE_PROVIDER_PATH_SEGMENTS["google-drive"]).toBe("gdrive");
    expect(STORAGE_PROVIDER_PATH_SEGMENTS.dropbox).toBe("dropbox");
    expect(Object.keys(STORAGE_PROVIDER_PATH_SEGMENTS).sort()).toEqual(["dropbox", "google-drive"]);
  });
});

describe("parseStorageRecordingRef", () => {
  it("parses legacy bare Drive file id as google-drive", () => {
    expect(parseStorageRecordingRef("1AbCdEfGhIjKlMnOpQrStUv")).toEqual({
      provider: "google-drive",
      fileId: "1AbCdEfGhIjKlMnOpQrStUv",
    });
  });

  it("parses legacy bare path URL as google-drive", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/1AbCdEfGhIjKlMnOp")).toEqual({
      provider: "google-drive",
      fileId: "1AbCdEfGhIjKlMnOp",
    });
  });

  it("parses namespaced /gdrive/<id>", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/gdrive/1AbCdEf")).toEqual({
      provider: "google-drive",
      fileId: "1AbCdEf",
    });
    expect(parseStorageRecordingRef("/gdrive/1AbCdEf")).toEqual({
      provider: "google-drive",
      fileId: "1AbCdEf",
    });
  });

  it("parses namespaced /dropbox/<id>", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/dropbox/dbx-file")).toEqual({
      provider: "dropbox",
      fileId: "dbx-file",
    });
  });

  it("fails closed on legacy /onedrive/<id> (removed provider)", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/onedrive/od-item")).toBeNull();
    expect(parseStorageRecordingRef("/onedrive/u!abc")).toBeNull();
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/?id=x&provider=onedrive")).toBeNull();
  });

  it("parses multi-segment file ids after the provider prefix", () => {
    expect(parseStorageRecordingRef("/dropbox/folder/file-id")).toEqual({
      provider: "dropbox",
      fileId: "folder/file-id",
    });
  });

  it("parses ?id= query as google-drive by default", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/player.html?id=driveFile99")).toEqual(
      {
        provider: "google-drive",
        fileId: "driveFile99",
      },
    );
  });

  it("honors ?provider= with ?id=", () => {
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/?id=x&provider=dropbox")).toEqual({
      provider: "dropbox",
      fileId: "x",
    });
  });

  it("returns null for empty / reserved paths", () => {
    expect(parseStorageRecordingRef("")).toBeNull();
    expect(parseStorageRecordingRef(null)).toBeNull();
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/")).toBeNull();
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/privacy")).toBeNull();
    expect(parseStorageRecordingRef("https://tracing.gnas.dev/gdrive")).toBeNull();
  });

  it("rejects bare ids containing a dot (not a Drive file id shape)", () => {
    expect(parseStorageRecordingRef("file.name")).toBeNull();
    expect(parseStorageRecordingRef("report.json")).toBeNull();
  });

  it("decodes URI-encoded file ids", () => {
    expect(parseStorageRecordingRef("/gdrive/abc%2Fdef")).toEqual({
      provider: "google-drive",
      fileId: "abc/def",
    });
  });

  it("decodes encoded Dropbox shared-link ids including rlkey", () => {
    const id = "scl/fi/abc/file.zip?rlkey=secret";
    const url = `https://tracing.gnas.dev/dropbox/${encodeURIComponent(id)}`;
    expect(parseStorageRecordingRef(url)).toEqual({
      provider: "dropbox",
      fileId: id,
    });
  });
});

describe("buildCloudRemoteOpenUrl", () => {
  it("opens Google Drive package file from /gdrive/<fileId> recording URL", () => {
    expect(
      buildCloudRemoteOpenUrl({
        recordingUrl: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMn",
        folderRef: "1FolderIdXXXX",
      }),
    ).toBe("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view");
  });

  it("falls back to Google Drive folder when recording URL is missing", () => {
    expect(
      buildCloudRemoteOpenUrl({
        provider: "google-drive",
        folderRef: "1FolderIdXXXX",
      }),
    ).toBe("https://drive.google.com/drive/folders/1FolderIdXXXX");
  });

  it("rejects Drive slash-path folder refs", () => {
    expect(
      buildCloudRemoteOpenUrl({
        provider: "google-drive",
        folderRef: "/gn-tracing",
      }),
    ).toBeNull();
  });

  it("opens Dropbox shared-link view from encoded replay URL", () => {
    const replayId = "scl/fi/abc123/file.zip?rlkey=xyz";
    const recordingUrl = `https://tracing.gnas.dev/dropbox/${encodeURIComponent(replayId)}`;
    expect(
      buildCloudRemoteOpenUrl({
        recordingUrl,
        folderRef: "/gn-tracing",
      }),
    ).toBe("https://www.dropbox.com/scl/fi/abc123/file.zip?rlkey=xyz&dl=0");
  });

  it("falls back to Dropbox home folder path when no shared-link id", () => {
    expect(
      buildCloudRemoteOpenUrl({
        provider: "dropbox",
        folderRef: "/gn-tracing",
      }),
    ).toBe("https://www.dropbox.com/home/gn-tracing");
    expect(
      buildCloudRemoteOpenUrl({
        provider: "dropbox",
        folderRef: "/",
      }),
    ).toBe("https://www.dropbox.com/home");
  });

  it("buildCloudFolderOpenUrl remains as folder-only helper alias", () => {
    expect(buildCloudFolderOpenUrl("dropbox", "/a/b")).toBe("https://www.dropbox.com/home/a/b");
    expect(buildCloudFolderOpenUrl("google-drive", "1FolderIdXXXX")).toBe(
      "https://drive.google.com/drive/folders/1FolderIdXXXX",
    );
  });
});

describe("resolveHistoryProvider", () => {
  it("prefers the stored provider field", () => {
    expect(resolveHistoryProvider("dropbox", "https://tracing.gnas.dev/gdrive/x")).toBe("dropbox");
  });

  it("infers provider from the recording URL when missing", () => {
    expect(resolveHistoryProvider(undefined, "https://tracing.gnas.dev/dropbox/scl/fi/x")).toBe(
      "dropbox",
    );
    expect(resolveHistoryProvider(undefined, "https://tracing.gnas.dev/gdrive/abc")).toBe(
      "google-drive",
    );
  });

  it("defaults to google-drive when nothing is known", () => {
    expect(resolveHistoryProvider(undefined, null)).toBe("google-drive");
  });
});
