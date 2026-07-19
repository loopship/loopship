import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";

type SyncDatabase = {
  exec(sql: string): void;
  close(): void;
};

type SyncDatabaseConstructor = new (path: string) => SyncDatabase;

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
  const identity = prepareLockDatabase(path);
  const database = new Database(path);
  try {
    const opened = lstatSync(path);
    assertPrivateRegularLockTarget(opened, path);
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) {
      throw new Error(`file lock target changed while opening: ${path}`);
    }
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "SQLITE_BUSY" || /database is (?:locked|busy)/iu.test(message)) {
      throw Object.assign(new Error(`file lock is already held: ${path}`), {
        code: "loopship_file_lock_busy",
      });
    }
    throw error;
  }
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

function prepareLockDatabase(path: string): { dev: number | bigint; ino: number | bigint } {
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const state = lstatSync(path);
  assertPrivateRegularLockTarget(state, path);
  chmodSync(path, 0o600);
  return { dev: state.dev, ino: state.ino };
}

function assertPrivateRegularLockTarget(
  state: Stats,
  path: string,
): void {
  if (state.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link SQLite lock target: ${path}`);
  }
  if (!state.isFile()) {
    throw new Error(`SQLite lock target must be a regular file: ${path}`);
  }
  if (Number(state.nlink) !== 1) {
    throw new Error(`refusing hard-linked SQLite lock target: ${path}`);
  }
}
