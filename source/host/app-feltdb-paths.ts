import { app } from 'electron';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Manages FeltDB data directory paths for the macOS/Electron app.
 *
 * Data is stored in:
 * - macOS: ~/Library/Application Support/Grok Bot/.feltdb/
 * - Linux: ~/.config/Grok Bot/.feltdb/
 * - Windows: %APPDATA%/Grok Bot/.feltdb/
 *
 * This location ensures:
 * - Time Machine backup compatibility (macOS)
 * - Persistence across app versions
 * - Proper cleanup with app uninstall
 */
export class AppFeltDBPaths {
  private static instance: AppFeltDBPaths;
  private appDataDir: string;
  private feltdbDir: string;

  private constructor() {
    // Use Electron's userData path for app data
    // On macOS, this is ~/Library/Application Support/Grok Bot/
    this.appDataDir = app.getPath('userData');
    this.feltdbDir = join(this.appDataDir, '.feltdb');
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): AppFeltDBPaths {
    if (!this.instance) {
      this.instance = new AppFeltDBPaths();
    }
    return this.instance;
  }

  /**
   * Get the FeltDB root directory path.
   */
  getFeltDBRootPath(): string {
    return this.feltdbDir;
  }

  /**
   * Get the app data directory path.
   */
  getAppDataPath(): string {
    return this.appDataDir;
  }

  /**
   * Ensure FeltDB directory exists.
   */
  async ensureFeltDBDirectory(): Promise<void> {
    try {
      await mkdir(this.feltdbDir, { recursive: true });
    } catch (error) {
      console.error('[app-feltdb-paths] Failed to create FeltDB directory:', error);
      throw error;
    }
  }

  /**
   * Get a subdirectory path within FeltDB.
   */
  getSubdirectory(name: string): string {
    return join(this.feltdbDir, name);
  }

  /**
   * Log configuration for diagnostics.
   */
  logConfiguration(): void {
    console.log('[app-feltdb-paths] Configuration:');
    console.log(`  - App data: ${this.appDataDir}`);
    console.log(`  - FeltDB root: ${this.feltdbDir}`);
  }
}

/**
 * Initialize FeltDB paths for the application.
 * Call this early in app startup, before other components.
 */
export async function initializeAppFeltDBPaths(): Promise<AppFeltDBPaths> {
  const paths = AppFeltDBPaths.getInstance();
  await paths.ensureFeltDBDirectory();
  paths.logConfiguration();
  return paths;
}
