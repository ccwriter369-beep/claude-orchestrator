import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Versioned } from "./types";

const STORAGE_DIR = join(homedir(), ".claude", "orchestrator");

/** Ensure storage directory exists */
export function ensureStorageDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function storagePath(filename: string): string {
  return join(STORAGE_DIR, filename);
}

/**
 * Atomic write: write to .tmp, fsync, rename.
 * Prevents corruption on crash/power loss.
 */
export function atomicWrite(filename: string, data: unknown): void {
  ensureStorageDir();
  const target = storagePath(filename);
  const tmp = target + ".tmp";
  const json = JSON.stringify(data, null, 2);

  writeFileSync(tmp, json, "utf-8");

  // fsync the temp file to ensure data is on disk
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);

  // Atomic rename
  renameSync(tmp, target);
}

/**
 * Read a JSON store file. Returns default if missing.
 * Validates schema_version field.
 */
export function readStore<T extends Versioned>(filename: string, defaultValue: T): T {
  ensureStorageDir();
  const target = storagePath(filename);

  if (!existsSync(target)) {
    return defaultValue;
  }

  try {
    const raw = readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw) as T;

    // Schema version check — for now, we accept version 1
    if (parsed.schema_version !== defaultValue.schema_version) {
      // Future: run migrations here
      // For now, accept and update version
      parsed.schema_version = defaultValue.schema_version;
    }

    return parsed;
  } catch {
    // Corrupted file — return default (the .tmp may still exist from a failed write)
    return defaultValue;
  }
}

/**
 * Read + modify + atomic write pattern.
 * Ensures consistent read-modify-write cycles.
 */
export function updateStore<T extends Versioned>(
  filename: string,
  defaultValue: T,
  updater: (store: T) => T
): T {
  const current = readStore(filename, defaultValue);
  const updated = updater(current);
  atomicWrite(filename, updated);
  return updated;
}

/** Get the storage directory path (for dispatch session dirs) */
export function getStorageDir(): string {
  ensureStorageDir();
  return STORAGE_DIR;
}
