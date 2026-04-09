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

  constructor(opts: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    rootFolderId: string;
  }) {
    const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
    auth.setCredentials({
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
    });
    this.drive = google.drive({ version: "v3", auth });
    this.rootFolderId = opts.rootFolderId;
    this.folderIdCache.set("", opts.rootFolderId);
  }

  async readFile(filePath: string): Promise<string> {
    const fileId = await this.resolveFileId(filePath);
    if (!fileId) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Google Docs need export (can't use alt:media). Skip the metadata
    // check for .md files to avoid an extra API call per read.
    if (!filePath.endsWith(".md")) {
      const meta = await this.drive.files.get({
        fileId,
        fields: "mimeType",
      });

      if (meta.data.mimeType === "application/vnd.google-apps.document") {
        const res = await this.drive.files.export(
          { fileId, mimeType: "text/markdown" },
          { responseType: "text" },
        );
        return res.data as string;
      }
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

    return this.listFilesRecursive(
      folderId,
      subPath || "",
      recursive,
      new Set(),
    );
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
    visited: Set<string>,
  ): Promise<string[]> {
    // Cycle detection — shortcuts can create loops
    if (visited.has(folderId)) return [];
    visited.add(folderId);

    const results: string[] = [];

    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, shortcutDetails)",
        pageSize: 1000,
        pageToken,
      });

      const files = res.data.files || [];

      for (const file of files) {
        if (!file.name || file.name.startsWith(".")) continue;

        const relativePath = prefix ? `${prefix}/${file.name}` : file.name;

        // Resolve shortcuts to their targets
        let mimeType = file.mimeType;
        let fileId = file.id;
        if (
          mimeType === "application/vnd.google-apps.shortcut" &&
          file.shortcutDetails
        ) {
          mimeType = file.shortcutDetails.targetMimeType || "";
          fileId = file.shortcutDetails.targetId || file.id;
        }

        if (mimeType === "application/vnd.google-apps.folder") {
          if (recursive && fileId) {
            this.folderIdCache.set(relativePath, fileId);
            results.push(
              ...(await this.listFilesRecursive(
                fileId,
                relativePath,
                true,
                visited,
              )),
            );
          }
        } else if (file.name.endsWith(".md")) {
          results.push(relativePath);
        } else if (mimeType === "application/vnd.google-apps.document") {
          // Include Google Docs (users can compile these)
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
      fields: "files(id, mimeType, shortcutDetails)",
      pageSize: 1,
    });

    const file = res.data.files?.[0];
    if (!file) return null;

    // Resolve shortcut to target file
    if (
      file.mimeType === "application/vnd.google-apps.shortcut" &&
      file.shortcutDetails?.targetId
    ) {
      return file.shortcutDetails.targetId;
    }

    return file.id || null;
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

      // Look for folders OR shortcuts (which might point to folders)
      const res = await this.drive.files.list({
        q: `'${currentId}' in parents and name = '${escapeDriveQuery(part)}' and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
        fields: "files(id, mimeType, shortcutDetails)",
        pageSize: 5,
      });

      let folderId: string | undefined;
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          folderId = f.id || undefined;
          break;
        }
        if (
          f.mimeType === "application/vnd.google-apps.shortcut" &&
          f.shortcutDetails?.targetMimeType ===
            "application/vnd.google-apps.folder"
        ) {
          folderId = f.shortcutDetails.targetId || undefined;
          break;
        }
      }
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

      // Try to find existing folder or shortcut-to-folder
      const res = await this.drive.files.list({
        q: `'${currentId}' in parents and name = '${escapeDriveQuery(part)}' and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`,
        fields: "files(id, mimeType, shortcutDetails)",
        pageSize: 5,
      });

      let folderId: string | undefined;
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          folderId = f.id || undefined;
          break;
        }
        if (
          f.mimeType === "application/vnd.google-apps.shortcut" &&
          f.shortcutDetails?.targetMimeType ===
            "application/vnd.google-apps.folder"
        ) {
          folderId = f.shortcutDetails.targetId || undefined;
          break;
        }
      }

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
