import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseBunLock, type BunLock } from './parse';

export type LockfileFormat = 'text' | 'binary';

/**
 * Heuristically determine whether a lockfile is the legacy binary format.
 * A text bun.lock is JSONC, so its first non-whitespace byte is '{'.
 */
export function isBinaryLockfile(filePath: string, name: string): boolean {
  if (name.endsWith('.lockb')) {
    return true;
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64);
    const read = fs.readSync(fd, buf, 0, 64, 0);
    for (let i = 0; i < read; i++) {
      const b = buf[i]!;
      // skip whitespace and a UTF-8 BOM
      if (
        b === 0x20 ||
        b === 0x09 ||
        b === 0x0a ||
        b === 0x0d ||
        b === 0xef ||
        b === 0xbb ||
        b === 0xbf
      ) {
        continue;
      }
      return b !== 0x7b; // '{'
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Convert a legacy binary bun.lockb into the text format by shelling out to
 * `bun`. Requires `bun` on PATH (e.g. via `oven-sh/setup-bun`). Writes a
 * `bun.lock` in the working directory (fine for ephemeral CI checkouts).
 */
export function convertBinaryLockfile(workingDir: string): string {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (bunCheck.error || bunCheck.status !== 0) {
    throw new Error(
      'A binary bun.lockb was provided, but `bun` is not available on PATH. ' +
        'Add a step using `oven-sh/setup-bun` before this action, or migrate to the ' +
        'text lockfile with `bun install --save-text-lockfile`.'
    );
  }

  // `--frozen-lockfile` refuses to rewrite an out-of-date lockfile; retry
  // without it if the frozen attempt fails for that reason.
  let ran = spawnSync(
    'bun',
    ['install', '--lockfile-only', '--save-text-lockfile', '--frozen-lockfile'],
    { cwd: workingDir, encoding: 'utf8' }
  );
  if (ran.status !== 0) {
    ran = spawnSync('bun', ['install', '--lockfile-only', '--save-text-lockfile'], {
      cwd: workingDir,
      encoding: 'utf8',
    });
  }
  if (ran.error || ran.status !== 0) {
    const detail = ran.stderr || ran.stdout || String(ran.error);
    throw new Error(`Failed to convert binary bun.lockb via bun (exit ${ran.status}): ${detail}`);
  }

  const textPath = path.join(workingDir, 'bun.lock');
  if (!fs.existsSync(textPath)) {
    throw new Error('bun did not produce a text bun.lock during conversion.');
  }
  return fs.readFileSync(textPath, 'utf8');
}

/**
 * Load and parse a bun lockfile from disk, handling both the text (bun.lock)
 * and legacy binary (bun.lockb) formats.
 */
export function loadLockfile(
  workingDirectory: string,
  lockfileName: string
): { data: BunLock; lockfilePath: string; format: LockfileFormat } {
  const workingDir = path.resolve(workingDirectory || '.');
  const lockfilePath = path.join(workingDir, lockfileName);

  if (!fs.existsSync(lockfilePath)) {
    throw new Error(
      `Lockfile not found: ${lockfilePath}. Set the \`working-directory\` and/or \`lockfile\` inputs.`
    );
  }

  let text: string;
  let format: LockfileFormat;
  if (isBinaryLockfile(lockfilePath, lockfileName)) {
    format = 'binary';
    text = convertBinaryLockfile(workingDir);
  } else {
    format = 'text';
    text = fs.readFileSync(lockfilePath, 'utf8');
  }

  const data = parseBunLock(text);
  return { data, lockfilePath, format };
}
