import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { code } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const workDir = join(here, '.tmp', 'cli');

const fixture: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { vue: '^3.4.0', vuex: '^4.1.0' } }),
    'src/store/index.js': code`
        import { createStore } from 'vuex';
        import todos from './todos';

        export default createStore({
          modules: { todos },
        });
    `,
    'src/store/todos.js': code`
        export default {
          namespaced: true,
          state: () => ({
            list: [],
          }),
          mutations: {
            add(state, todo) {
              state.list.push(todo);
            },
          },
        };
    `,
    'src/App.vue': code`
        <template>
          <button @click="add('x')">{{ list.length }}</button>
        </template>

        <script>
        import { mapState, mapMutations } from 'vuex';

        export default {
          computed: mapState('todos', ['list']),
          methods: mapMutations('todos', ['add']),
        };
        </script>
    `,
    // must never be touched
    'node_modules/dep/index.js': `import { createStore } from 'vuex';\nexport default createStore({});\n`,
};

function cli(...args: string[]): string {
    return execFileSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'src/cli.ts'), ...args], {
        cwd: workDir,
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
}

const read = (path: string): string => readFileSync(join(workDir, path), 'utf-8');

beforeEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    for (const [path, content] of Object.entries(fixture)) {
        const file = join(workDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('cli', () => {
    it('--dry-run prints a diff and leaves the files alone', () => {
        const output = cli('src', '--dry-run');

        expect(output).toContain('Using store:');
        expect(output).toContain('useTodosStore');
        expect(output).toContain(`+export const useTodosStore = defineStore('todos', {`);
        expect(output).toContain(`-import { mapState, mapMutations } from 'vuex';`);
        expect(output).toContain('3 file(s) would change');
        expect(read('src/store/todos.js')).toBe(fixture['src/store/todos.js']);
    }, 30_000);

    it('writes the migrated files and detects the store on its own', () => {
        const output = cli('.');

        expect(output).toContain('3 file(s) changed');
        expect(output).toContain('npm install pinia');

        expect(read('src/store/index.js')).toBe(code`
            import { createPinia } from 'pinia';

            export default createPinia();
        `);
        expect(read('src/store/todos.js')).toContain(`export const useTodosStore = defineStore('todos', {`);
        expect(read('src/App.vue')).toContain(`computed: mapState(useTodosStore, ['list']),`);
        expect(read('src/App.vue')).toContain(`methods: mapActions(useTodosStore, ['add']),`);
        expect(read('node_modules/dep/index.js')).toBe(fixture['node_modules/dep/index.js']);

        // running it again finds nothing left to do
        expect(() => cli('.')).toThrow(/could not find a file that creates the Vuex store/);
    }, 30_000);

    it('rejects unknown transforms', () => {
        expect(() => cli('src', '--only', 'nope')).toThrow(/unknown transform/);
        cpSync(join(workDir, 'src/App.vue'), join(workDir, 'src/Copy.vue'));
        expect(cli('src', '--only', 'store', '--dry-run')).toContain('2 file(s) would change');
    }, 30_000);
});
