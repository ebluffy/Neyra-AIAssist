import { readFile } from 'node:fs/promises';
import { requireAdmin } from '../../../../../lib/admin-guard';
import { coreGet, coreGetReady, type CoreHealth, type CoreMeta } from '../../../../../lib/core-admin';
import { readBackups, readDiskUsage } from '../../../../../lib/admin-system';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReadyReport {
  ok?: boolean;
  checks?: Array<{ name?: string; ok?: boolean; reason?: string }>;
}

// Система: здоровье ядра, версия, uptime процесса сайта, диск, бэкапы.
// Ничего не выдумываем: чего ядро не сообщает, то помечено как «не сообщается».
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const deployShaFile = process.env.NEYRA_DEPLOY_SHA_FILE ?? '/opt/neyra/web/app/.deploy-sha';
  const [health, ready, meta, disk, backups, deployCommit] = await Promise.all([
    coreGet<CoreHealth>('/v1/health', { timeoutMs: 4000 }),
    coreGetReady<ReadyReport>('/v1/health/ready', { timeoutMs: 4000 }),
    coreGet<CoreMeta>('/v1/meta', { timeoutMs: 3000 }),
    readDiskUsage(),
    readBackups(process.env.NEYRA_BACKUP_DIR),
    readFile(deployShaFile, 'utf8').then((value) => value.trim() || null).catch(() => null),
  ]);
  return jsonOk({
    site: {
      version: process.env.NEYRA_WEB_VERSION ?? null,
      commit: deployCommit ?? process.env.NEYRA_COMMIT ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      disk,
      backups,
    },
    core: {
      health: { state: health.state, message: health.message ?? null, data: health.data },
      ready: { state: ready.state, message: ready.message ?? null, data: ready.data },
      meta: { state: meta.state, message: meta.message ?? null, data: meta.data },
    },
  });
}
