import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib/config.mjs";

/**
 * Bundle @feltdb/core with the Electron app.
 *
 * This script ensures FeltDB is included in app.asar.unpacked so it's
 * available at runtime without requiring npm installation.
 *
 * FeltDB is bundled to:
 * - app.asar.unpacked/node_modules/@feltdb/core/
 *
 * This allows the app to:
 * - Self-host FeltDB without external dependencies
 * - Persist data in ~/.../Grok Bot/.feltdb/
 * - Enable provider switching with context preservation
 * - Support automatic crash recovery
 */
export async function bundleFeltDB({ unpackedRoot, stageRoot } = {}) {
  const nodeModulesRoot = path.join(repoRoot, "node_modules");
  const feltdbSource = path.join(nodeModulesRoot, "@feltdb", "core");
  const feltdbDest = path.join(unpackedRoot, "node_modules", "@feltdb", "core");

  console.log("[bundle-feltdb] Bundling @feltdb/core with app...");
  console.log(`  Source: ${feltdbSource}`);
  console.log(`  Destination: ${feltdbDest}`);

  try {
    // Ensure destination directory exists
    await mkdir(path.dirname(feltdbDest), { recursive: true });

    // Remove existing FeltDB if present
    await rm(feltdbDest, { recursive: true, force: true });

    // Copy FeltDB
    await cp(feltdbSource, feltdbDest, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true
    });

    console.log("[bundle-feltdb] ✓ @feltdb/core bundled successfully");

    // Verify package.json exists
    const packageJsonPath = path.join(feltdbDest, "package.json");
    const packageJson = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(packageJson);

    console.log(`[bundle-feltdb] FeltDB version: ${pkg.version}`);
    console.log(`[bundle-feltdb] Main entry: ${pkg.main || "index.js"}`);

    return { feltdbDest, feltdbVersion: pkg.version };
  } catch (error) {
    console.error("[bundle-feltdb] Error bundling FeltDB:", error);
    throw error;
  }
}

/**
 * Verify FeltDB is properly bundled.
 */
export async function verifyFeltDBBundle({ unpackedRoot } = {}) {
  const packageJsonPath = path.join(
    unpackedRoot,
    "node_modules",
    "@feltdb",
    "core",
    "package.json"
  );

  try {
    const packageJson = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(packageJson);

    if (!pkg.name || !pkg.name.includes("feltdb")) {
      throw new Error("Invalid package.json for @feltdb/core");
    }

    console.log("[bundle-feltdb] ✓ FeltDB bundle verified");
    return true;
  } catch (error) {
    console.error("[bundle-feltdb] FeltDB bundle verification failed:", error);
    return false;
  }
}

/**
 * Create a manifest of bundled FeltDB for diagnostics.
 */
export async function createFeltDBManifest({ unpackedRoot, stageRoot } = {}) {
  const feltdbDir = path.join(unpackedRoot, "node_modules", "@feltdb", "core");
  const manifestPath = path.join(stageRoot, "dist", "feltdb-manifest.json");

  try {
    const packageJsonPath = path.join(feltdbDir, "package.json");
    const packageJson = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(packageJson);

    const manifest = {
      bundled: true,
      name: pkg.name,
      version: pkg.version,
      location: feltdbDir,
      bundledAt: new Date().toISOString(),
      purpose: "Durable state substrate for provider switching and inference caching"
    };

    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n"
    );

    console.log("[bundle-feltdb] ✓ FeltDB manifest created");
    return manifest;
  } catch (error) {
    console.error("[bundle-feltdb] Error creating manifest:", error);
    throw error;
  }
}
