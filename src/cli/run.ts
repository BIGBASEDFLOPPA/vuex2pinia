import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cac } from 'cac';
import pc from 'picocolors';
import { findStoreFile, scanFiles } from '../core/file-scanner.js';
import type { ReportMessage } from '../core/reporter.js';
import { TRANSFORM_NAMES, migrate, type MigrateResult, type TransformName } from '../migrate.js';
import { renderDiff } from './diff.js';

interface CliOptions {
    store?: string;
    dryRun?: boolean;
    only?: string;
    ext: string;
    rootStore?: string;
    format?: boolean;
}

type Formatter = (source: string, filePath: string) => Promise<string>;

const cli = cac('vuex2pinia');

cli
    .command('[path]', 'Path to the directory (or file) to migrate')
    .option('--store <path>', 'Path to the root Vuex store file (e.g. src/store/index.ts); detected automatically when omitted')
    .option('--dry-run', 'Show a diff of the changes without writing to disk')
    .option('--only <transforms>', `Apply only the given transforms (comma-separated: ${TRANSFORM_NAMES.join(', ')})`)
    .option('--ext <extensions>', 'File extensions to process', {
        default: '.vue,.ts,.js,.tsx,.jsx,.mjs',
    })
    .option('--root-store <id>', 'Id of the Pinia store generated from root-level state (default: root)')
    .option('--format', 'Format changed files with the Prettier installed in your project')
    .example('vuex2pinia ./src')
    .example('vuex2pinia ./src --store ./src/store/index.ts --dry-run')
    .action(async (path: string | undefined, options: CliOptions) => {
        try {
            await run(path ?? '.', options);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(pc.red(`Error: ${message}`));
            process.exit(1);
        }
    });

cli.help();
cli.version('0.1.0');
cli.parse();

async function run(path: string, options: CliOptions): Promise<void> {
    const extensions = String(options.ext)
        .split(',')
        .map((ext) => ext.trim())
        .filter(Boolean)
        .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

    const files = await scanFiles(path, { extensions });
    if (files.length === 0) {
        console.log(pc.yellow('No files found.'));
        return;
    }

    const storePath = options.store ?? (await detectStore(files));

    let only: TransformName[] | undefined;
    if (options.only) {
        const names = String(options.only).split(',').map((name) => name.trim());
        const unknown = names.filter((name) => !TRANSFORM_NAMES.includes(name as TransformName));
        if (unknown.length > 0) {
            throw new Error(`unknown transform(s): ${unknown.join(', ')}. Available: ${TRANSFORM_NAMES.join(', ')}`);
        }
        only = names as TransformName[];
    }

    const result = migrate({ storePath, files, rootStoreId: options.rootStore, only });
    const cwd = process.cwd();
    const rel = (file: string): string => relative(cwd, file) || file;

    printStores(result, rel);

    const formatter = options.format ? await loadFormatter(cwd) : null;
    let changedCount = 0;

    for (const file of result.files) {
        if (!file.changed) continue;
        changedCount++;

        let output = file.transformedSource;
        if (formatter) {
            try {
                output = await formatter(output, file.path);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.log(pc.yellow(`Could not format ${rel(file.path)}: ${message}`));
            }
        }

        if (options.dryRun) {
            console.log(pc.bold(rel(file.path)), pc.dim(file.kind === 'store' ? '[store]' : '[source]'));
            console.log(renderDiff(file.originalSource, output));
            console.log();
        } else {
            await writeFile(file.path, output, 'utf-8');
            console.log(pc.green(`Updated ${rel(file.path)}`));
        }
    }

    printMessages(result.messages, rel);
    printSummary(result, changedCount, rel, !!options.dryRun);
}

async function detectStore(files: string[]): Promise<string> {
    const candidates = await findStoreFile(files);
    const [first] = candidates;

    if (!first) {
        throw new Error('could not find a file that creates the Vuex store — pass it with --store <path>');
    }
    if (candidates.length > 1) {
        throw new Error(`several files create a Vuex store, pick one with --store <path>:\n${candidates.map((c) => `  - ${c}`).join('\n')}`);
    }

    console.log(pc.dim(`Using store: ${first}`));
    return first;
}

async function loadFormatter(cwd: string): Promise<Formatter | null> {
    try {
        const require = createRequire(join(resolvePath(cwd), 'package.json'));
        type Prettier = typeof import('prettier');
        const loaded = (await import(pathToFileURL(require.resolve('prettier')).href)) as Prettier & { default?: Prettier };
        // the CommonJS build exposes its API on the default export
        const prettier = typeof loaded.format === 'function' ? loaded : loaded.default!;
        return async (source, filePath) => {
            const config = await prettier.resolveConfig(filePath);
            return prettier.format(source, { ...config, filepath: filePath });
        };
    } catch {
        console.log(pc.yellow('--format: Prettier is not installed in this project, files are written unformatted.'));
        return null;
    }
}

function printStores(result: MigrateResult, rel: (file: string) => string): void {
    if (result.stores.length === 0) return;

    console.log(pc.bold('Pinia stores:'));
    for (const store of result.stores) {
        const origin = store.path === '' ? 'root' : store.path;
        console.log(`  ${pc.cyan(store.exportName)} ${pc.dim(`("${store.storeId}", from ${origin})`)} ${pc.dim('→')} ${rel(store.file)}`);
    }
    console.log();
}

const LEVEL_LABEL: Record<ReportMessage['level'], (text: string) => string> = {
    todo: (text) => pc.red(text),
    warning: (text) => pc.yellow(text),
    info: (text) => pc.blue(text),
};

function printMessages(messages: ReportMessage[], rel: (file: string) => string): void {
    if (messages.length === 0) return;

    const byFile = new Map<string, ReportMessage[]>();
    for (const message of messages) {
        const list = byFile.get(message.file) ?? [];
        list.push(message);
        byFile.set(message.file, list);
    }

    console.log();
    console.log(pc.bold('Needs your attention:'));
    for (const [file, list] of byFile) {
        console.log(`  ${pc.underline(rel(file))}`);
        list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
        for (const message of list) {
            const position = message.line !== undefined ? pc.dim(`:${message.line} `) : '';
            console.log(`    ${LEVEL_LABEL[message.level](message.level.padEnd(7))} ${position}${message.message}`);
        }
    }
}

function printSummary(result: MigrateResult, changedCount: number, rel: (file: string) => string, dryRun: boolean): void {
    const todos = result.messages.filter((m) => m.level === 'todo').length;
    const warnings = result.messages.filter((m) => m.level === 'warning').length;

    console.log();
    console.log(
        pc.cyan(
            `${changedCount} file(s) ${dryRun ? 'would change' : 'changed'}, ${result.files.length - changedCount} unchanged — ${todos} TODO(s), ${warnings} warning(s).`,
        ),
    );

    if (result.remainingVuexFiles.length > 0) {
        console.log(pc.yellow(`\nStill importing "vuex" (finish these by hand):`));
        for (const file of result.remainingVuexFiles) console.log(pc.yellow(`  - ${rel(file)}`));
    }

    if (dryRun) {
        if (changedCount > 0) console.log(pc.dim('\nRun without --dry-run to write these changes.'));
        return;
    }
    if (changedCount === 0) return;

    console.log(pc.bold('\nNext steps:'));
    console.log('  1. npm install pinia');
    if (result.vueVersion === 2) {
        console.log('  2. Pass the Pinia instance to the root component: new Vue({ pinia, ... }) (Vue 2 needs PiniaVuePlugin)');
    } else {
        console.log('  2. Make sure the app installs Pinia: app.use(pinia) — the root store file now exports the Pinia instance');
    }
    console.log('  3. Search the code base for "TODO(vuex2pinia)" and resolve what is left');
    console.log('  4. npm uninstall vuex once nothing imports it anymore');
}
