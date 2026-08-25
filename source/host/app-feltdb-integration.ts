import { ipcMain } from 'electron';
import type { FeltDBClient } from '../packages/feltdb-operations/feltdb-client.js';
import { FeltDBClient as FeltDBClientImpl } from '../packages/feltdb-operations/feltdb-client.js';
import { HostFeltDBRuntime } from './host-feltdb-runtime.js';
import { AppFeltDBPaths, initializeAppFeltDBPaths } from './app-feltdb-paths.js';

/**
 * Manages FeltDB integration in the Electron app context.
 *
 * Responsibilities:
 * - Initialize FeltDB with app-specific paths
 * - Expose FeltDB through IPC for renderer access
 * - Handle app lifecycle (startup/shutdown)
 * - Provide diagnostics and monitoring
 */
export class AppFeltDBIntegration {
  private runtime: HostFeltDBRuntime | null = null;
  private feltdb: FeltDBClient | null = null;
  private appPaths: AppFeltDBPaths | null = null;
  private isInitialized = false;

  /**
   * Initialize FeltDB during app startup.
   * Call this early in the main process initialization.
   */
  async initialize(): Promise<FeltDBClient> {
    if (this.isInitialized) {
      throw new Error('AppFeltDBIntegration already initialized');
    }

    try {
      console.log('[app-feltdb-integration] Initializing FeltDB for app');

      // Get app-specific paths
      this.appPaths = AppFeltDBPaths.getInstance();
      await initializeAppFeltDBPaths();

      // Initialize FeltDB runtime
      this.runtime = new HostFeltDBRuntime({
        sandRootDir: this.appPaths.getAppDataPath(),
        log: console
      });

      this.feltdb = await this.runtime.initialize();
      this.isInitialized = true;

      console.log('[app-feltdb-integration] FeltDB initialized successfully');

      // Setup IPC handlers for renderer access
      this.setupIPCHandlers();

      return this.feltdb;
    } catch (error) {
      console.error('[app-feltdb-integration] Failed to initialize FeltDB:', error);
      throw error;
    }
  }

  /**
   * Setup IPC handlers to expose FeltDB methods to renderer.
   */
  private setupIPCHandlers(): void {
    if (!this.feltdb) {
      throw new Error('FeltDB not initialized');
    }

    // Diagnostics endpoint
    ipcMain.handle('feltdb:diagnostics', async () => {
      if (!this.runtime) {
        return { initialized: false };
      }
      return await this.runtime.getDiagnostics();
    });

    // Inference context endpoint
    ipcMain.handle('feltdb:inference-context', async (event, args) => {
      if (!this.feltdb?.inference) {
        throw new Error('Inference store not available');
      }

      const { turnId } = args as { turnId: string };
      if (!turnId) {
        throw new Error('Missing turnId');
      }

      const requests = await this.feltdb.inference.queryRequestsByStatus('completed');

      return {
        turnId,
        requests: requests || [],
        responses: []
      };
    });

    // Provider context endpoint
    ipcMain.handle('feltdb:provider-context', async (event, args) => {
      if (!this.feltdb?.providerContexts) {
        throw new Error('Provider context store not available');
      }

      const { providerId } = args as { providerId?: string };

      if (providerId) {
        const context = await this.feltdb.providerContexts.get(providerId);
        return context;
      }

      // Return all provider contexts
      return { message: 'List all providers endpoint - TODO: implement queryAll' };
    });
  }

  /**
   * Shutdown FeltDB during app shutdown.
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized || !this.runtime) {
      return;
    }

    try {
      console.log('[app-feltdb-integration] Shutting down FeltDB');
      await this.runtime.shutdown();
      this.isInitialized = false;
      this.runtime = null;
      this.feltdb = null;
    } catch (error) {
      console.error('[app-feltdb-integration] Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Get the FeltDB client instance.
   */
  getFeltDB(): FeltDBClient {
    if (!this.feltdb) {
      throw new Error('FeltDB not initialized');
    }
    return this.feltdb;
  }

  /**
   * Check if FeltDB is initialized.
   */
  isReady(): boolean {
    return this.isInitialized && this.feltdb !== null;
  }

  /**
   * Get diagnostics about FeltDB state.
   */
  async getDiagnostics(): Promise<any> {
    if (!this.runtime) {
      return { initialized: false };
    }
    return await this.runtime.getDiagnostics();
  }
}

/**
 * Global singleton instance.
 */
let globalIntegration: AppFeltDBIntegration | null = null;

/**
 * Get or create the global AppFeltDBIntegration instance.
 */
export function getAppFeltDBIntegration(): AppFeltDBIntegration {
  if (!globalIntegration) {
    globalIntegration = new AppFeltDBIntegration();
  }
  return globalIntegration;
}

/**
 * Initialize the global FeltDB integration.
 * Call from the main process early in app startup.
 */
export async function initializeAppFeltDB(): Promise<FeltDBClient> {
  const integration = getAppFeltDBIntegration();
  return await integration.initialize();
}

/**
 * Shutdown the global FeltDB integration.
 * Call from the main process on app shutdown.
 */
export async function shutdownAppFeltDB(): Promise<void> {
  if (globalIntegration) {
    await globalIntegration.shutdown();
  }
}
