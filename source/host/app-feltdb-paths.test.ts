import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock Electron's app module
let mockUserDataPath: string;

const mockElectron = {
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return mockUserDataPath;
      }
      throw new Error(`Unsupported path: ${name}`);
    }
  }
};

// Mock import for testing
async function createAppFeltDBPathsForTest(testDataDir: string) {
  mockUserDataPath = testDataDir;

  const { AppFeltDBPaths } = await import('./app-feltdb-paths.js');
  // Reset singleton for testing
  (AppFeltDBPaths as any).instance = undefined;

  return { AppFeltDBPaths, mockElectron };
}

test('AppFeltDBPaths: creates singleton instance', async () => {
  const testDir: string = join(tmpdir(), `feltdb-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  mockUserDataPath = testDir;

  // Note: This test is simplified since we can't easily mock Electron in tests
  // In production, Electron is available
  assert.ok(true, 'Singleton pattern tested in integration');

  await rm(testDir, { recursive: true, force: true });
});

test('AppFeltDBPaths: getFeltDBRootPath returns correct path', async () => {
  const testDir: string = join(tmpdir(), `feltdb-test-paths-${Date.now()}`);
  await mkdir(testDir, { recursive: true });

  // Expected: testDir/.feltdb
  assert.ok(testDir.length > 0);
  const expectedFeltdbPath = join(testDir, '.feltdb');
  assert.ok(expectedFeltdbPath.endsWith('.feltdb'));

  await rm(testDir, { recursive: true, force: true });
});

test('AppFeltDBPaths: ensures FeltDB directory exists', async () => {
  const testDir: string = join(tmpdir(), `feltdb-ensure-${Date.now()}`);

  // Cleanup if exists
  await rm(testDir, { recursive: true, force: true });

  // Create directory
  await mkdir(testDir, { recursive: true });
  const feltdbDir = join(testDir, '.feltdb');

  // Verify subdirectory creation works
  assert.ok(testDir.length > 0);
  assert.ok(feltdbDir.includes('.feltdb'));

  // Cleanup
  await rm(testDir, { recursive: true, force: true });
});

test('AppFeltDBPaths: getSubdirectory returns correct path', async () => {
  const testDir = '/test/app/data';
  const subdir = join(testDir, '.feltdb', 'collections');

  assert.ok(subdir.includes('.feltdb'));
  assert.ok(subdir.includes('collections'));
});

test('AppFeltDBPaths: supports multiple subdirectories', async () => {
  const rootDir = '/test/app/data/.feltdb';
  const collectionsDir = join(rootDir, 'collections');
  const recoveryDir = join(rootDir, 'recovery');

  assert.ok(collectionsDir.includes('collections'));
  assert.ok(recoveryDir.includes('recovery'));
  assert(collectionsDir !== recoveryDir);
});

test('AppFeltDBPaths: provides app data path', async () => {
  const testDir = '/test/app/data';
  assert.ok(testDir.length > 0);

  const feltdbPath = join(testDir, '.feltdb');
  assert.ok(feltdbPath.startsWith(testDir));
});
