import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export async function readDiskUsage(path = '/'): Promise<DiskUsage | null> {
  try {
    const info = await statfs(path);
    return {
      totalBytes: Number(info.blocks) * Number(info.bsize),
      freeBytes: Number(info.bfree) * Number(info.bsize),
    };
  } catch {
    return null;
  }
}

export interface BackupFile {
  name: string;
  size: number;
  modifiedAt: string;
}

// Список бэкапов читается только если администратор задал NEYRA_BACKUP_DIR.
// Создание бэкапа панель не запускает: это делается по согласованию на сервере.
export async function readBackups(dir: string | undefined): Promise<{ configured: boolean; items: BackupFile[] }> {
  if (!dir) return { configured: false, items: [] };
  try {
    const names = await readdir(dir);
    const items: BackupFile[] = [];
    for (const name of names.slice(0, 100)) {
      try {
        const info = await stat(join(dir, name));
        if (!info.isFile()) continue;
        items.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {
        // Один нечитаемый файл не должен ломать список.
      }
    }
    items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { configured: true, items };
  } catch {
    return { configured: true, items: [] };
  }
}
