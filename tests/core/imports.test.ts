import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScript } from '../../src/core/ast.js';
import {
    collectUsedNames,
    ensureNamedImport,
    importSources,
    importsFrom,
    removeOrphanedImports,
    removeStatement,
} from '../../src/core/imports.js';
import { Project, memoryFileSystem, type ScriptUnit } from '../../src/core/project.js';
import { code } from '../helpers.js';

function load(source: string, name = 'file.js'): { unit: ScriptUnit; render: () => string } {
    const path = resolve(`/project/${name}`);
    const project = new Project(memoryFileSystem({ [path]: source }));
    const file = project.load(path)!;
    return { unit: file.scripts[0]!, render: () => project.render(file) };
}

const usedNames = (source: string, lang: 'js' | 'ts' | 'tsx' = 'js'): string[] => [...collectUsedNames(parseScript(source, lang))].sort();

describe('collectUsedNames', () => {
    it('does not count import specifiers as a use', () => {
        expect(usedNames(`import a, { b, c as d } from 'x';\nimport * as e from 'y';\n`)).toEqual([]);
    });

    it('counts objects and computed keys, but not property names', () => {
        expect(usedNames(`a.b.c;\nd[e];\nf?.g;\n`)).toEqual(['a', 'd', 'e', 'f']);
    });

    it('counts shorthand values and computed keys, but not plain keys', () => {
        expect(usedNames(`const o = { a, b: c, [d]: 1, e() {} };\n`)).toEqual(['a', 'c', 'd', 'o']);
    });

    it('counts the local side of an export specifier only', () => {
        expect(usedNames(`const a = 1;\nexport { a as b };\n`)).toEqual(['a']);
    });

    it('ignores labels', () => {
        expect(usedNames(`outer: for (;;) { break outer; }\n`)).toEqual([]);
    });

    it('sees names used only in type positions', () => {
        expect(usedNames(`let a: Foo<Bar>;\nlet b: ns.Baz;\ninterface I { key: Qux }\n`, 'ts')).toEqual([
            'Bar',
            'Foo',
            'I',
            'Qux',
            'a',
            'b',
            'ns',
        ]);
    });

    it('sees JSX element names, but not attributes or member properties', () => {
        expect(usedNames(`const x = <Foo bar={baz}><ns.Item /></Foo>;\n`, 'tsx')).toEqual(['Foo', 'baz', 'ns', 'x']);
    });
});

describe('ensureNamedImport', () => {
    it('adds a new declaration after the last import', () => {
        const { unit } = load(code`
            import Vue from 'vue';
            import { ref } from 'vue';

            export const a = ref(0);
        `);
        ensureNamedImport(unit, 'pinia', 'defineStore');

        expect(importSources(unit)).toEqual(['vue', 'vue', 'pinia']);
        expect(unit.ast.program.body.map((node) => node.type)).toEqual([
            'ImportDeclaration',
            'ImportDeclaration',
            'ImportDeclaration',
            'ExportNamedDeclaration',
        ]);
    });

    it('adds a declaration at the top of a file without imports', () => {
        const { unit, render } = load(`export const a = 1;\n`);
        ensureNamedImport(unit, 'pinia', 'defineStore');

        expect(render()).toBe(code`
            import { defineStore } from 'pinia';

            export const a = 1;
        `);
    });

    it('merges into an existing declaration of the same source', () => {
        const { unit, render } = load(`import { createPinia } from 'pinia';\n\ncreatePinia();\n`);
        ensureNamedImport(unit, 'pinia', 'defineStore');

        expect(render()).toBe(`import { createPinia, defineStore } from 'pinia';\n\ncreatePinia();\n`);
    });

    it('does nothing when the import is already there', () => {
        const source = `import { defineStore } from 'pinia';\n\ndefineStore('a', {});\n`;
        const { unit, render } = load(source);
        ensureNamedImport(unit, 'pinia', 'defineStore');

        expect(importsFrom(unit, 'pinia')[0]!.specifiers).toHaveLength(1);
        expect(render()).toBe(source);
    });

    it('supports a local alias', () => {
        const { unit, render } = load(`import { mapState } from 'vuex';\n\nmapState();\n`);
        ensureNamedImport(unit, 'pinia', 'mapState', 'mapPiniaState');
        // asking again for the same alias must not add it twice
        ensureNamedImport(unit, 'pinia', 'mapState', 'mapPiniaState');

        expect(importsFrom(unit, 'pinia')).toHaveLength(1);
        expect(render()).toContain(`import { mapState as mapPiniaState } from 'pinia';`);
    });

    it('does not merge into type-only or namespace imports', () => {
        const { unit } = load(`import type { Store } from 'pinia';\nimport * as pinia from 'pinia';\n\nlet s: Store = pinia;\n`, 'file.ts');
        ensureNamedImport(unit, 'pinia', 'defineStore');

        const declarations = importsFrom(unit, 'pinia');
        expect(declarations).toHaveLength(3);
        expect(declarations[2]!.specifiers.map((s) => s.local.name)).toEqual(['defineStore']);
    });
});

describe('removeOrphanedImports', () => {
    it('drops specifiers whose last use was removed', () => {
        const { unit, render } = load(code`
            import { mapState, mapGetters } from 'vuex';
            import helper from './helper';

            export const a = mapState(['x']);
            export const b = mapGetters(['y']);
            helper();
        `);
        unit.ast.program.body.splice(3, 2);
        removeOrphanedImports(unit);

        expect(render()).toBe(code`
            import { mapState } from 'vuex';

            export const a = mapState(['x']);
        `);
    });

    it('keeps imports that were unused to begin with, and side-effect imports', () => {
        const source = code`
            import './setup';
            import unused from './unused';
            import { used } from './used';

            used();
        `;
        const { unit, render } = load(source);
        removeOrphanedImports(unit);

        expect(render()).toBe(source);
    });
});

describe('removeStatement', () => {
    it('keeps the leading comment of the first statement', () => {
        const { unit, render } = load(code`
            // license header
            import Vuex from 'vuex';
            import Vue from 'vue';

            Vue.use(Vuex);
        `);
        const body = unit.ast.program.body;
        removeStatement(body, body[0]!);

        expect(render()).toBe(code`
            // license header
            import Vue from 'vue';

            Vue.use(Vuex);
        `);
    });

    it('ignores a statement that is not in the body', () => {
        const { unit } = load(`const a = 1;\nconst b = 2;\n`);
        const body = unit.ast.program.body;
        const [first] = body.splice(0, 1);
        removeStatement(body, first!);

        expect(body).toHaveLength(1);
    });
});

describe('importsFrom / importSources', () => {
    it('lists import declarations by source', () => {
        const { unit } = load(`import Vue from 'vue';\nimport { mapState } from 'vuex';\nimport Vuex from 'vuex';\n`);

        expect(importSources(unit)).toEqual(['vue', 'vuex', 'vuex']);
        expect(importsFrom(unit, 'vuex')).toHaveLength(2);
        expect(importsFrom(unit, 'pinia')).toEqual([]);
    });
});
