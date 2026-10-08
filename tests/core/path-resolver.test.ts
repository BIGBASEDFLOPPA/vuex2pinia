import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathResolver, loadAliases } from '../../src/core/path-resolver.js';
import { memoryFileSystem } from '../../src/core/project.js';

const p = (path: string): string => resolve(`/project/${path}`);

function resolverFor(files: string[], aliases = [{ prefix: '@', target: p('src') }]): PathResolver {
    return new PathResolver(memoryFileSystem(Object.fromEntries(files.map((file) => [p(file), '']))), aliases);
}

describe('PathResolver.resolveImport', () => {
    it('resolves relative imports, trying the known extensions', () => {
        const resolver = resolverFor(['src/store/cart.ts', 'src/App.vue']);

        expect(resolver.resolveImport('./cart', p('src/store/index.ts'))).toBe(p('src/store/cart.ts'));
        expect(resolver.resolveImport('../App.vue', p('src/store/index.ts'))).toBe(p('src/App.vue'));
    });

    it('resolves a directory to its index file', () => {
        const resolver = resolverFor(['src/store/index.js']);

        expect(resolver.resolveImport('./store', p('src/main.js'))).toBe(p('src/store/index.js'));
    });

    it('resolves aliased imports, including the bare alias', () => {
        const resolver = resolverFor(['src/store/index.js', 'src/index.js']);

        expect(resolver.resolveImport('@/store', p('src/views/Home.vue'))).toBe(p('src/store/index.js'));
        expect(resolver.resolveImport('@', p('src/views/Home.vue'))).toBe(p('src/index.js'));
    });

    it('maps ESM-style .js / .jsx specifiers onto TypeScript files', () => {
        const resolver = resolverFor(['src/store/cart.ts', 'src/Widget.tsx']);

        expect(resolver.resolveImport('./cart.js', p('src/store/index.ts'))).toBe(p('src/store/cart.ts'));
        expect(resolver.resolveImport('./Widget.jsx', p('src/main.ts'))).toBe(p('src/Widget.tsx'));
    });

    it('returns null for packages and for files that do not exist', () => {
        const resolver = resolverFor(['src/store/index.js']);

        expect(resolver.resolveImport('vuex', p('src/main.js'))).toBeNull();
        expect(resolver.resolveImport('./missing', p('src/main.js'))).toBeNull();
        expect(resolver.resolveImport('@other/store', p('src/main.js'))).toBeNull();
    });
});

describe('PathResolver.toSpecifier', () => {
    const resolver = resolverFor([]);

    it('builds a relative specifier without the extension', () => {
        expect(resolver.toSpecifier(p('src/store/index.js'), p('src/store/modules/cart.js'))).toBe('./modules/cart');
        expect(resolver.toSpecifier(p('src/views/Home.vue'), p('src/store/cart.ts'))).toBe('../store/cart');
    });

    it('drops a trailing /index', () => {
        expect(resolver.toSpecifier(p('src/main.js'), p('src/store/index.js'))).toBe('./store');
    });

    it('spells out index instead of producing "." or ".."', () => {
        expect(resolver.toSpecifier(p('src/store/cart.js'), p('src/store/index.js'))).toBe('./index');
        expect(resolver.toSpecifier(p('src/store/modules/cart.js'), p('src/store/index.js'))).toBe('../index');
    });

    it('uses an alias only when the file already imports through it', () => {
        const from = p('src/views/Home.vue');
        const to = p('src/store/cart.js');

        expect(resolver.toSpecifier(from, to)).toBe('../store/cart');
        expect(resolver.toSpecifier(from, to, ['@'])).toBe('@/store/cart');
    });

    it('falls back to a relative path for files outside the alias target', () => {
        expect(resolver.toSpecifier(p('src/main.js'), p('shared/cart.js'), ['@'])).toBe('../shared/cart');
    });
});

describe('PathResolver.aliasPrefixesIn', () => {
    it('lists the aliases used by the given import sources', () => {
        const resolver = resolverFor([], [
            { prefix: '@', target: p('src') },
            { prefix: '~', target: p('src') },
        ]);

        expect(resolver.aliasPrefixesIn(['vue', '@/store', './local'])).toEqual(['@']);
        expect(resolver.aliasPrefixesIn(['@scope/pkg', 'vue'])).toEqual([]);
    });
});

describe('loadAliases', () => {
    it('reads compilerOptions.paths relative to baseUrl', () => {
        const fs = memoryFileSystem({
            [p('tsconfig.json')]: JSON.stringify({
                compilerOptions: { baseUrl: './src', paths: { '#/*': ['./*'], '@components/*': ['components/*'] } },
            }),
        });

        expect(loadAliases(fs, p('src/store'))).toEqual([
            { prefix: '#', target: p('src') },
            { prefix: '@components', target: p('src/components') },
        ]);
    });

    it('tolerates comments and trailing commas in the config', () => {
        const fs = memoryFileSystem({
            [p('jsconfig.json')]: `{
                // aliases
                "compilerOptions": {
                    /* the url below is not a comment */
                    "paths": { "@/*": ["src/*"], "docs/*": ["http://example.com/*"], },
                },
            }`,
        });

        expect(loadAliases(fs, p('.'))).toEqual([
            { prefix: '@', target: p('src') },
            { prefix: 'docs', target: resolve(p('.'), 'http://example.com') },
        ]);
    });

    it('skips path patterns that are not simple wildcards', () => {
        const fs = memoryFileSystem({
            [p('tsconfig.json')]: JSON.stringify({ compilerOptions: { paths: { exact: ['src/exact.ts'], '@/*': ['src/*'] } } }),
        });

        expect(loadAliases(fs, p('.'))).toEqual([{ prefix: '@', target: p('src') }]);
    });

    it('falls back to @ and ~ pointing at src next to package.json', () => {
        const fs = memoryFileSystem({
            [p('package.json')]: '{}',
            [p('tsconfig.json')]: 'not json',
        });

        expect(loadAliases(fs, p('src/store/modules'))).toEqual([
            { prefix: '@', target: p('src') },
            { prefix: '~', target: p('src') },
        ]);
    });

    it('returns nothing when there is no project root', () => {
        expect(loadAliases(memoryFileSystem({}), p('src'))).toEqual([]);
    });
});
