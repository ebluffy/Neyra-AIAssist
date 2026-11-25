import { readdir, readFile, stat, statfs } from 'node:fs/promises';
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
      // bavail — сколько реально доступно процессу сайта; bfree включает зарезерв root.
      freeBytes: Number(info.bavail ?? info.bfree) * Number(info.bsize),
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

// Коммит сайта берём из файла выкладки: NEYRA_COMMIT в .env остаётся от сборки
// и после `deploy-web.sh` показывает старый SHA. Файл пишет сам деплой.
export async function readDeployCommit(
  file = process.env.NEYRA_DEPLOY_SHA_FILE ?? '/opt/neyra/web/app/.deploy-sha',
): Promise<string | null> {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    return value ? value.slice(0, 12) : null;
  } catch {
    return null;
  }
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
