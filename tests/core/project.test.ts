import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project, memoryFileSystem } from '../../src/core/project.js';
import { code } from '../helpers.js';

const p = (path: string): string => resolve(`/project/${path}`);

function projectWith(files: Record<string, string>): Project {
    return new Project(memoryFileSystem(Object.fromEntries(Object.entries(files).map(([path, content]) => [p(path), content]))));
}

describe('memoryFileSystem', () => {
    const fs = memoryFileSystem({
        [p('src/main.js')]: 'main',
        [p('src/store/index.js')]: 'store',
        [p('src/store/modules/cart.js')]: 'cart',
    });

    it('reads files by any spelling of their path', () => {
        expect(fs.readFile(p('src/main.js'))).toBe('main');
        expect(fs.readFile(p('src/store/../main.js'))).toBe('main');
        expect(fs.readFile(p('src/missing.js'))).toBeUndefined();
    });

    it('tells files from directories', () => {
        expect(fs.isFile(p('src/main.js'))).toBe(true);
        expect(fs.isFile(p('src/store'))).toBe(false);
        expect(fs.isFile(p('src/missing.js'))).toBe(false);
    });

    it('lists the direct entries of a directory', () => {
        expect(fs.readDir(p('src'))).toEqual([
            { name: 'main.js', isDirectory: false },
            { name: 'store', isDirectory: true },
        ]);
        expect(fs.readDir(p('src/store'))).toEqual([
            { name: 'index.js', isDirectory: false },
            { name: 'modules', isDirectory: true },
        ]);
    });

    it('returns undefined for something that is not a directory', () => {
        expect(fs.readDir(p('src/main.js'))).toBeUndefined();
        expect(fs.readDir(p('other'))).toBeUndefined();
    });
});

describe('Project', () => {
    it('loads a module as a single script unit and caches it', () => {
        const project = projectWith({ 'src/a.ts': `import { b } from './b';\nexport const a: number = b;\n` });

        const file = project.load(p('src/a.ts'))!;
        expect(file.scripts).toHaveLength(1);
        expect(file.scripts[0]).toMatchObject({ kind: 'module', lang: 'ts', start: 0, end: file.source.length });
        expect(project.load(p('src/../src/a.ts'))).toBe(file);
        expect(project.moduleUnit(p('src/a.ts'))).toBe(file.scripts[0]);
        expect(project.loaded()).toEqual([file]);
    });

    it('returns null for a file that does not exist', () => {
        const project = projectWith({});

        expect(project.load(p('src/missing.js'))).toBeNull();
        expect(project.moduleUnit(p('src/missing.js'))).toBeNull();
        expect(project.loaded()).toEqual([]);
    });

    it('loads both script blocks of an SFC with their offsets', () => {
        const source = code`
            <template>
              <div>{{ n }}</div>
            </template>

            <script>
            export default { name: 'Widget' };
            </script>

            <script setup lang="ts">
            const n: number = 1;
            </script>
        `;
        const project = projectWith({ 'src/Widget.vue': source });

        const file = project.load(p('src/Widget.vue'))!;
        expect(file.error).toBeUndefined();
        expect(file.scripts.map((unit) => [unit.kind, unit.lang])).toEqual([
            ['script', 'js'],
            ['scriptSetup', 'ts'],
        ]);
        for (const unit of file.scripts) expect(source.slice(unit.start, unit.end)).toBe(unit.source);
        expect(project.moduleUnit(p('src/Widget.vue'))).toBeNull();
    });

    it('ignores script blocks that point at an external file', () => {
        const project = projectWith({ 'src/Widget.vue': `<template><div /></template>\n<script src="./widget.js"></script>\n` });

        expect(project.load(p('src/Widget.vue'))!.scripts).toEqual([]);
    });

    it('records a parse error instead of throwing', () => {
        const project = projectWith({ 'src/broken.js': 'export default {' });

        const file = project.load(p('src/broken.js'))!;
        expect(file.error).toEqual(expect.any(String));
        expect(file.scripts).toEqual([]);
        expect(project.moduleUnit(p('src/broken.js'))).toBeNull();
    });

    it('tracks the names used in a script', () => {
        const project = projectWith({ 'src/a.js': `import { used, unused } from './b';\nexport const a = used.value;\n` });

        const unit = project.moduleUnit(p('src/a.js'))!;
        expect([...unit.initiallyUsed].sort()).toEqual(['a', 'used']);
        expect([...unit.userNames].sort()).toEqual(['a', 'unused', 'used', 'value']);
    });

    it('renders untouched files byte for byte', () => {
        const sources = {
            'src/a.js': `import {b} from "./b"\r\n\r\nexport const a = {\r\n\tb,   c: 1\r\n}\r\n`,
            'src/Widget.vue': `<template>\n  <div/>\n</template>\n\n<script>\nexport default   { name: 'Widget' }\n</script>\n`,
        };
        const project = projectWith(sources);

        for (const [path, source] of Object.entries(sources)) {
            expect(project.render(project.load(p(path))!)).toBe(source);
        }
    });

    it('applies template edits from the end of the file backwards', () => {
        const project = projectWith({ 'src/Widget.vue': `<template><p>{{ a }} {{ b }}</p></template>\n` });
        const file = project.load(p('src/Widget.vue'))!;

        const a = file.source.indexOf('a }}');
        const b = file.source.indexOf('b }}');
        file.templateEdits.push({ start: a, end: a + 1, text: 'first' }, { start: b, end: b + 1, text: 'second' });

        expect(project.render(file)).toBe(`<template><p>{{ first }} {{ second }}</p></template>\n`);
    });

    it('does not render an added <script setup> block that stayed empty', () => {
        const source = `<template><div /></template>\n`;
        const project = projectWith({ 'src/Widget.vue': source });
        const file = project.load(p('src/Widget.vue'))!;

        const unit = project.addScriptSetup(file);
        expect(unit).toMatchObject({ kind: 'scriptSetup', synthetic: true });
        expect(file.scripts).toEqual([unit]);
        expect(project.render(file)).toBe(source);
    });
});
