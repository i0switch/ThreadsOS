import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function atomicWriteTextFile(
  targetPath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, content, { encoding: "utf-8", mode });
  await fs.rename(tempPath, targetPath);

  try {
    await fs.chmod(targetPath, mode);
  } catch {
    // Windows may ignore POSIX file modes. Best effort only.
  }
}
