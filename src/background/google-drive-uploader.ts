interface DriveFileMetadata {
  name: string;
  parents?: string[];
  mimeType?: string;
}

export class GoogleDriveUploader {
  private accessToken: string;
  private folderId?: string;

  constructor(accessToken: string, folderId?: string) {
    this.accessToken = accessToken;
    this.folderId = folderId;
  }

  async uploadVideo(blob: Blob, filename: string): Promise<string> {
    const metadata: DriveFileMetadata = {
      name: filename,
      parents: this.folderId ? [this.folderId] : undefined,
    };

    const formData = new FormData();
    formData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    formData.append("file", blob, filename);

    const response = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Upload failed with status ${response.status}`);
    }

    const result = await response.json();
    return result.id;
  }

  async uploadJson(data: string, filename: string): Promise<string> {
    const metadata: DriveFileMetadata = {
      name: filename,
      parents: this.folderId ? [this.folderId] : undefined,
      mimeType: "application/json",
    };

    const formData = new FormData();
    formData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    formData.append("file", new Blob([data], { type: "application/json" }), filename);

    const response = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Upload failed with status ${response.status}`);
    }

    const result = await response.json();
    return result.id;
  }

  async createShareableLink(fileId: string): Promise<string> {
    // Make file readable by anyone with the link
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "anyone",
          role: "reader",
        }),
      }
    );

    if (!response.ok) {
      console.error("[Drive] Failed to create shareable link:", await response.text());
    }

    return `https://drive.google.com/file/d/${fileId}/view`;
  }

  async getVideoUrl(fileId: string): Promise<string> {
    // For video playback, we need to use a special URL format
    return `https://drive.google.com/file/d/${fileId}/preview`;
  }
}
