import { google, type drive_v3 } from "googleapis";
import type { StorageBackend } from "./storage.js";

/**
 * Google Drive storage backend.
 * Reads/writes Obsidian vault files stored in a Google Drive folder.
 * Used for the hosted cloud version (Claude.ai integration).
 */
export class GoogleDriveBackend implements StorageBackend {
  private drive: drive_v3.Drive;
  private rootFolderId: string;
  // Cache folder IDs to avoid repeated lookups
  private folderIdCache = new Map<string, string>();

  constructor(accessToken: string, rootFolderId: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.drive = google.drive({ version: "v3", auth });
    this.rootFolderId = rootFolderId;
    this.folderIdCache.set("", rootFolderId);
  }

  async readFile(filePath: string): Promise<string> {
    const fileId = await this.resolveFileId(filePath);
    if (!fileId) {
      throw new Error(`File not found: ${filePath}`);
    }

    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "text" },
    );

    return res.data as string;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const dirPath = filePath.includes("/")
      ? filePath.substring(0, filePath.lastIndexOf("/"))
      : "";
    const fileName = filePath.includes("/")
      ? filePath.substring(filePath.lastIndexOf("/") + 1)
      : filePath;

    // Ensure parent directories exist
    const parentId = await this.ensureDirectoryPath(dirPath);

    // Check if file already exists
    const existingId = await this.resolveFileId(filePath);

    if (existingId) {
      // Update existing file
      await this.drive.files.update({
        fileId: existingId,
        media: {
          mimeType: "text/markdown",
          body: content,
        },
      });
    } else {
      // Create new file
      await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [parentId],
          mimeType: "text/markdown",
        },
        media: {
          mimeType: "text/markdown",
          body: content,
        },
      });
    }
  }

  async listFiles(subPath?: string, recursive = true): Promise<string[]> {
    const folderId = subPath
      ? await this.resolveFolderId(subPath)
      : this.rootFolderId;

    if (!folderId) return [];

    return this.listFilesRecursive(folderId, subPath || "", recursive);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      // Check if it's a file
      const fileId = await this.resolveFileId(filePath);
      if (fileId) return true;

      // Check if it's a folder
      const folderId = await this.resolveFolderId(filePath);
      return !!folderId;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    await this.ensureDirectoryPath(dirPath);
  }

  // --- Internal helpers ---

  private async listFilesRecursive(
    folderId: string,
    prefix: string,
    recursive: boolean,
  ): Promise<string[]> {
    const results: string[] = [];

    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 1000,
        pageToken,
      });

      const files = res.data.files || [];

      for (const file of files) {
        if (!file.name || file.name.startsWith(".")) continue;

        const relativePath = prefix ? `${prefix}/${file.name}` : file.name;

        if (file.mimeType === "application/vnd.google-apps.folder") {
          if (recursive && file.id) {
            // Cache this folder ID
            this.folderIdCache.set(relativePath, file.id);
            results.push(
              ...(await this.listFilesRecursive(file.id, relativePath, true)),
            );
          }
        } else if (file.name.endsWith(".md")) {
          results.push(relativePath);
        }
      }

      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return results;
  }

  private async resolveFileId(filePath: string): Promise<string | null> {
    const parts = filePath.split("/");
    const fileName = parts.pop()!;
    const dirPath = parts.join("/");

    const parentId = dirPath
      ? await this.resolveFolderId(dirPath)
      : this.rootFolderId;

    if (!parentId) return null;

    const res = await this.drive.files.list({
      q: `'${parentId}' in parents and name = '${escapeDriveQuery(fileName)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id)",
      pageSize: 1,
    });

    return res.data.files?.[0]?.id || null;
  }

  private async resolveFolderId(dirPath: string): Promise<string | null> {
    if (!dirPath) return this.rootFolderId;

    // Check cache
    const cached = this.folderIdCache.get(dirPath);
    if (cached) return cached;

    // Walk the path
    const parts = dirPath.split("/");
    let currentId = this.rootFolderId;
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      const cached = this.folderIdCache.get(currentPath);
      if (cached) {
        currentId = cached;
        continue;
      }

      const res = await this.drive.files.list({
        q: `'${currentId}' in parents and name = '${escapeDriveQuery(part)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
      });

      const folderId = res.data.files?.[0]?.id;
      if (!folderId) return null;

      this.folderIdCache.set(currentPath, folderId);
      currentId = folderId;
    }

    return currentId;
  }

  private async ensureDirectoryPath(dirPath: string): Promise<string> {
    if (!dirPath) return this.rootFolderId;

    const parts = dirPath.split("/");
    let currentId = this.rootFolderId;
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      const cached = this.folderIdCache.get(currentPath);
      if (cached) {
        currentId = cached;
        continue;
      }

      // Try to find existing folder
      const res = await this.drive.files.list({
        q: `'${currentId}' in parents and name = '${escapeDriveQuery(part)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
      });

      let folderId = res.data.files?.[0]?.id;

      if (!folderId) {
        // Create the folder
        const createRes = await this.drive.files.create({
          requestBody: {
            name: part,
            parents: [currentId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
        });
        folderId = createRes.data.id!;
      }

      this.folderIdCache.set(currentPath, folderId);
      currentId = folderId;
    }

    return currentId;
  }
}

function escapeDriveQuery(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
