import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileSystem } from './project.js';

export interface Alias {
    /** Import prefix without the trailing slash, e.g. `@` or `~`. */
    prefix: string;
    /** Absolute directory the prefix points at. */
    target: string;
}

const RESOLVE_SUFFIXES = [
    '',
    '.ts',
    '.js',
    '.mjs',
    '.tsx',
    '.jsx',
    '.vue',
    '/index.ts',
    '/index.js',
    '/index.mjs',
    '/index.tsx',
    '/index.jsx',
];

const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

export class PathResolver {
    constructor(
        private fs: FileSystem,
        public aliases: Alias[] = [],
    ) {}

    /** Resolves a relative or aliased import specifier to an absolute file path. */
    resolveImport(specifier: string, fromFile: string): string | null {
        let base: string | null = null;

        if (specifier.startsWith('.')) {
            base = resolve(dirname(fromFile), specifier);
        } else {
            for (const alias of this.aliases) {
                if (specifier === alias.prefix) base = alias.target;
                else if (specifier.startsWith(`${alias.prefix}/`)) base = join(alias.target, specifier.slice(alias.prefix.length + 1));
                if (base) break;
            }
        }

        if (!base) return null;

        const candidates = [base];
        // TS projects in ESM mode import `./foo.js` while the file on disk is `foo.ts`
        if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.(m?)js$/, '.$1ts'));
        if (/\.jsx$/.test(base)) candidates.push(base.replace(/\.jsx$/, '.tsx'));

        for (const candidate of candidates) {
            for (const suffix of RESOLVE_SUFFIXES) {
                const path = candidate + suffix;
                if (this.fs.isFile(path)) return resolve(path);
            }
        }

        return null;
    }

    /** Builds an import specifier that points from one file at another. */
    toSpecifier(fromFile: string, toFile: string, preferredAliasPrefixes: string[] = []): string {
        const stripped = stripExtension(toFile);

        for (const alias of this.aliases) {
            if (!preferredAliasPrefixes.includes(alias.prefix)) continue;
            const rel = relative(alias.target, stripped);
            if (rel.startsWith('..') || resolve(alias.target, rel) !== resolve(stripped)) continue;
            const posix = rel.split(sep).join('/');
            return posix ? `${alias.prefix}/${posix}` : alias.prefix;
        }

        let rel = relative(dirname(fromFile), stripped).split(sep).join('/');
        // `from '.'` / `from '..'` are legal but easy to misread
        if (rel === '') rel = './index';
        else if (rel === '..' || rel.endsWith('/..')) rel = `${rel}/index`;
        else if (!rel.startsWith('.')) rel = `./${rel}`;
        return rel;
    }

    /** Alias prefixes already used by the given import sources. */
    aliasPrefixesIn(sources: string[]): string[] {
        return this.aliases
            .filter((alias) => sources.some((s) => s === alias.prefix || s.startsWith(`${alias.prefix}/`)))
            .map((alias) => alias.prefix);
    }
}

function stripExtension(filePath: string): string {
    let result = filePath.replace(SCRIPT_EXTENSION, '');
    const normalized = result.split(sep).join('/');
    if (normalized.endsWith('/index')) result = result.slice(0, -'/index'.length);
    return result;
}

/** Reads `compilerOptions.paths` from the nearest tsconfig/jsconfig; falls back to `@` and `~` -> `src`. */
export function loadAliases(fs: FileSystem, startDir: string): Alias[] {
    let dir = resolve(startDir);

    for (;;) {
        for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
            const content = fs.readFile(join(dir, name));
            if (content === undefined) continue;
            const aliases = aliasesFromConfig(content, dir);
            if (aliases.length > 0) return aliases;
        }

        if (fs.isFile(join(dir, 'package.json'))) {
            const src = join(dir, 'src');
            return [
                { prefix: '@', target: src },
                { prefix: '~', target: src },
            ];
        }

        const parent = dirname(dir);
        if (parent === dir) return [];
        dir = parent;
    }
}

function aliasesFromConfig(content: string, configDir: string): Alias[] {
    let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
        config = JSON.parse(stripJsonComments(content));
    } catch {
        return [];
    }

    const paths = config.compilerOptions?.paths;
    if (!paths) return [];

    const baseDir = resolve(configDir, config.compilerOptions?.baseUrl ?? '.');
    const aliases: Alias[] = [];

    for (const [pattern, targets] of Object.entries(paths)) {
        const target = targets[0];
        if (!target || !pattern.endsWith('/*') || !target.endsWith('/*')) continue;
        aliases.push({ prefix: pattern.slice(0, -2), target: resolve(baseDir, target.slice(0, -2)) });
    }

    return aliases;
}

function stripJsonComments(json: string): string {
    return json
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, str: string | undefined) => str ?? '')
        .replace(/,(\s*[}\]])/g, '$1');
}
