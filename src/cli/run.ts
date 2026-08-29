import { readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { cac } from 'cac';
import pc from 'picocolors';
import { scanFiles } from '../core/file-scanner.js';
import { runTransforms } from '../core/transform-runner.js';
import { runStoreTransforms } from '../core/store-transform-runner.js';
import { resolveStoreModules } from '../core/store-resolver.js';

import { renderDiff } from './diff.js';
import {componentTransformRegistry, storeTransformRegistry} from "../transforms/registry/registry";

const cli = cac('vuex2pinia');

cli
    .command('[path]', 'Path to the directory to migrate')
    .option('--store <path>', 'Path to the root Vuex store file (e.g. src/store/index.ts)')
    .option('--dry-run', 'Show a diff of changes without writing to disk')
    .option('--only <transforms>', 'Apply only the specified transforms (comma-separated)')
    .option('--ext <extensions>', 'File extensions to process', {
        default: '.vue,.ts',
    })
    .example('vuex2pinia ./src --store ./src/store/index.ts')
    .example('vuex2pinia ./src --store ./src/store/index.ts --dry-run')
    .action(async (path: string | undefined, options) => {
        if (!path) {
            console.error(pc.red('Error: please provide a path to a directory.'));
            console.log('Example: vuex2pinia ./src --store ./src/store/index.ts');
            process.exit(1);
        }

        if (!options.store) {
            console.error(pc.red('Error: please provide --store pointing at the root Vuex store file.'));
            console.log('Example: vuex2pinia ./src --store ./src/store/index.ts');
            process.exit(1);
        }

        let storeResult;
        try {
            storeResult = await resolveStoreModules(options.store);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(pc.red(`Failed to resolve store: ${message}`));
            process.exit(1);
        }

        if (storeResult.unresolved.length > 0) {
            console.log(pc.yellow(`${storeResult.unresolved.length} module(s) could not be resolved automatically:`));
            for (const u of storeResult.unresolved) {
                console.log(pc.yellow(`  - ${u.pathSegments.join('/')}: ${u.reason}`));
            }
            console.log();
        }

        const storeModulePaths = new Set(storeResult.resolved.map((m) => m.filePath));
        storeModulePaths.add(resolvePath(options.store));
        const extensions: string[] = String(options.ext)
            .split(',')
            .map((ext) => ext.trim());

        let files: string[];
        try {
            files = await scanFiles(path, { extensions });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(pc.red(`Scan failed: ${message}`));
            process.exit(1);
        }

        if (files.length === 0) {
            console.log(pc.yellow('No files found.'));
            return;
        }

        const only: string[] | undefined = options.only
            ? String(options.only).split(',').map((name: string) => name.trim())
            : undefined;

        let changedCount = 0;
        let unchangedCount = 0;

        for (const file of files) {
            const source = await readFile(file, 'utf-8');
            const isStoreModule = storeModulePaths.has(resolvePath(file));

            let result;
            try {
                result = isStoreModule
                    ? await runStoreTransforms(file, source, storeTransformRegistry, { only })
                    : runTransforms(file, source, componentTransformRegistry, { only });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(pc.red(`Failed to transform ${file}: ${message}`));
                continue;
            }

            if (!result.changed) {
                unchangedCount++;
                continue;
            }

            changedCount++;

            if (options.dryRun) {
                console.log(pc.bold(file), isStoreModule ? pc.dim('[store]') : pc.dim('[component]'));
                console.log(renderDiff(result.originalSource, result.transformedSource));
                console.log();
            } else {
                await writeFile(file, result.transformedSource, 'utf-8');
                console.log(pc.green(`Updated ${file}`));
            }
        }

        console.log(pc.cyan(`\n${changedCount} file(s) changed, ${unchangedCount} unchanged.`));

        if (options.dryRun && changedCount > 0) {
            console.log(pc.dim('Run without --dry-run to write these changes.'));
        }
    });

cli.help();
cli.version('0.1.0');

cli.parse();