import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findStoreFile, scanFiles } from '../../src/core/file-scanner.js';

const workDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'file-scanner');

const fixture: Record<string, string> = {
    'src/main.js': `import store from './store';\n`,
    'src/App.vue': `<template><div /></template>\n`,
    'src/types.d.ts': `declare const x: number;\n`,
    'src/readme.md': `# docs\n`,
    'src/store/index.js': `import { createStore } from 'vuex';\nexport default createStore({});\n`,
    'src/store/legacy.ts': `import Vuex from "vuex";\nexport default new Vuex.Store<RootState>({});\n`,
    'src/store/typed.ts': `import { createStore } from 'vuex';\nexport default createStore<RootState>({});\n`,
    'src/store/helpers.js': `import { mapState } from 'vuex';\nexport const helpers = mapState(['a']);\n`,
    'src/store/fake.js': `export const createStore = () => ({});\ncreateStore();\n`,
    'src/Store.vue': `<script>\nimport { createStore } from 'vuex';\ncreateStore({});\n</script>\n`,
    'node_modules/dep/index.js': `import { createStore } from 'vuex';\nexport default createStore({});\n`,
    'dist/bundle.js': `export {};\n`,
    '.nuxt/store.js': `export {};\n`,
};

const all = ['.js', '.ts', '.vue'];

const abs = (path: string): string => join(workDir, path);
const rel = (files: string[]): string[] => files.map((file) => relative(workDir, file).split(sep).join('/')).sort();

beforeAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    for (const [path, content] of Object.entries(fixture)) {
        mkdirSync(dirname(abs(path)), { recursive: true });
        writeFileSync(abs(path), content);
    }
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('scanFiles', () => {
    it('walks a directory, skipping build output, dependencies and .d.ts files', async () => {
        expect(rel(await scanFiles(workDir, { extensions: all }))).toEqual([
            'src/App.vue',
            'src/Store.vue',
            'src/main.js',
            'src/store/fake.js',
            'src/store/helpers.js',
            'src/store/index.js',
            'src/store/legacy.ts',
            'src/store/typed.ts',
        ]);
    });

    it('only returns the requested extensions', async () => {
        expect(rel(await scanFiles(workDir, { extensions: ['.vue'] }))).toEqual(['src/App.vue', 'src/Store.vue']);
    });

    it('accepts a single file', async () => {
        expect(rel(await scanFiles(abs('src/main.js'), { extensions: all }))).toEqual(['src/main.js']);
        expect(await scanFiles(abs('src/readme.md'), { extensions: all })).toEqual([]);
        expect(await scanFiles(abs('src/types.d.ts'), { extensions: all })).toEqual([]);
    });

    it('rejects a path that does not exist', async () => {
        await expect(scanFiles(abs('nope'), { extensions: all })).rejects.toThrow();
    });
});

describe('findStoreFile', () => {
    it('finds the scripts that import vuex and create a store', async () => {
        const files = await scanFiles(workDir, { extensions: all });

        expect(rel(await findStoreFile(files))).toEqual(['src/store/index.js', 'src/store/legacy.ts', 'src/store/typed.ts']);
    });

    it('returns nothing when no file creates a store', async () => {
        expect(await findStoreFile([abs('src/main.js'), abs('src/store/helpers.js')])).toEqual([]);
    });
});
