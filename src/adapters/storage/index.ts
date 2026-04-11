import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { logger } from "../../app/logger.js";

export interface StorageClient {
  saveFile(path: string, content: string | Buffer): Promise<void>;
  readFile(path: string): Promise<string>;
  listFiles(directory: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export class FileSystemStorageClient implements StorageClient {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? resolve(".");
  }

  private resolvePath(path: string): string {
    return resolve(this.basePath, path);
  }

  async saveFile(path: string, content: string | Buffer): Promise<void> {
    const fullPath = this.resolvePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    if (typeof content === "string") {
      await writeFile(fullPath, content, "utf8");
    } else {
      await writeFile(fullPath, content);
    }
    logger.debug({ path: fullPath }, "File saved");
  }

  async readFile(path: string): Promise<string> {
    const fullPath = this.resolvePath(path);
    return readFile(fullPath, "utf8");
  }

  async listFiles(directory: string): Promise<string[]> {
    const fullPath = this.resolvePath(directory);
    try {
      const entries = await readdir(fullPath, { recursive: true });
      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = join(fullPath, String(entry));
        const s = await stat(entryPath);
        if (s.isFile()) files.push(String(entry));
      }
      return files;
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(path));
      return true;
    } catch {
      return false;
    }
  }
}
