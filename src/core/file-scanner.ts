import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.nuxt', '.output', '.vuex2pinia-tmp']);

export interface ScanOptions {
    extensions: string[];
}

export async function scanFiles(targetPath: string, options: ScanOptions): Promise<string[]> {
    const stats = await stat(targetPath);

    if (stats.isFile()) {
        return hasMatchingExtension(targetPath, options.extensions) ? [targetPath] : [];
    }

    if (stats.isDirectory()) {
        return walkDirectory(targetPath, options);
    }

    return [];
}

async function walkDirectory(dirPath: string, options: ScanOptions): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const found: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            found.push(...(await walkDirectory(fullPath, options)));
            continue;
        }

        if (entry.isFile() && hasMatchingExtension(fullPath, options.extensions)) {
            found.push(fullPath);
        }
    }

    return found;
}

function hasMatchingExtension(filePath: string, extensions: string[]): boolean {
    if (filePath.endsWith('.d.ts')) return false;
    return extensions.includes(extname(filePath));
}

const STORE_CREATION = /\bcreateStore\s*(?:<[^>]*>)?\s*\(|\bnew\s+(?:Vuex\.)?Store\s*(?:<[^>]*>)?\s*\(/;

/** Finds the file that creates the Vuex store, for when `--store` is not given. */
export async function findStoreFile(files: string[]): Promise<string[]> {
    const candidates: string[] = [];

    for (const file of files) {
        if (!/\.[cm]?[jt]s$/.test(file)) continue;
        const source = await readFile(file, 'utf-8');
        if (/from\s+['"]vuex['"]/.test(source) && STORE_CREATION.test(source)) candidates.push(file);
    }

    return candidates;
}
