import { createRequire } from "node:module";
import { openLocalDurableSqliteDatabase } from "@cueintent/fastflow/native-scheduler";

type SyncDatabaseConstructor = new (path: string) => unknown;

const runtimeRequire = createRequire(import.meta.url);
const Database = (
  process.versions.bun
    ? runtimeRequire("bun:sqlite").Database
    : runtimeRequire("node:sqlite").DatabaseSync
) as SyncDatabaseConstructor;

export function openExclusiveSqliteTransaction(
  path: string,
  timeoutMs: number,
): () => void {
  const busyTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  let opened: ReturnType<typeof openLocalDurableSqliteDatabase> | undefined;
  try {
    opened = openLocalDurableSqliteDatabase(path, Database, { busyTimeoutMs });
    const { db: database } = opened;
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    opened?.db.close();
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "SQLITE_BUSY" || /database is (?:locked|busy)/iu.test(message)) {
      throw Object.assign(new Error(`file lock is already held: ${opened?.absolutePath ?? path}`), {
        code: "loopship_file_lock_busy",
      });
    }
    throw error;
  }
  const { db: database } = opened;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  };
}
