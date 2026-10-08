import { dirname, resolve } from 'node:path';
import type { MigrationContext } from './core/context.js';
import { importSources, removeOrphanedImports } from './core/imports.js';
import { PathResolver, loadAliases, type Alias } from './core/path-resolver.js';
import { Project, nodeFileSystem, type FileSystem, type FileUnit, type ScriptUnit } from './core/project.js';
import { Reporter, type ReportMessage } from './core/reporter.js';
import { analyzeStore } from './core/store-analyzer.js';
import type { StoreModel } from './core/store-model.js';
import { convertMapHelpers } from './transforms/component/convert-map-helpers.js';
import { convertStoreAccess } from './transforms/component/convert-store-access.js';
import { convertTemplate } from './transforms/component/convert-template.js';
import { convertVuexClass } from './transforms/component/convert-vuex-class.js';
import { StoreRefs } from './transforms/shared/store-refs.js';
import { convertStoreModules } from './transforms/store/convert-module.js';
import { convertRootFile } from './transforms/store/convert-root.js';

export type TransformName = 'store' | 'map-helpers' | 'store-access' | 'vuex-class' | 'template';

export const TRANSFORM_NAMES: TransformName[] = ['store', 'map-helpers', 'store-access', 'vuex-class', 'template'];

export interface MigrateOptions {
    /** Root Vuex store file (the one calling `createStore` / `new Vuex.Store`). */
    storePath: string;
    /** Files to migrate: components, composables, router, ... Store files are always included. */
    files: string[];
    fs?: FileSystem;
    /** Import aliases; read from tsconfig/jsconfig next to the store when omitted. */
    aliases?: Alias[];
    /** Id of the store created from root-level state/getters/mutations/actions (default: `root`). */
    rootStoreId?: string;
    /** Restrict the migration to some transforms. */
    only?: TransformName[];
}

export interface StoreSummary {
    /** Vuex namespace / state path, empty for the root store. */
    path: string;
    storeId: string;
    exportName: string;
    file: string;
}

export interface FileResult {
    path: string;
    kind: 'store' | 'source';
    originalSource: string;
    transformedSource: string;
    changed: boolean;
}

export interface MigrateResult {
    stores: StoreSummary[];
    unresolvedModules: { path: string; reason: string; file: string }[];
    files: FileResult[];
    messages: ReportMessage[];
    /** Files that still import from `vuex` after the migration. */
    remainingVuexFiles: string[];
    vueVersion: 2 | 3;
}

/** Libraries built on top of Vuex that need a manual migration strategy. */
const VUEX_ECOSYSTEM: Record<string, string> = {
    'vuex-class': 'some vuex-class decorators could not be migrated — replace them with getters/methods that use the Pinia stores',
    'vuex-module-decorators': 'vuex-module-decorators modules are not migrated — rewrite them as Pinia stores',
    'vuex-persistedstate': 'vuex-persistedstate does not work with Pinia — use pinia-plugin-persistedstate',
    'vuex-persist': 'vuex-persist does not work with Pinia — use pinia-plugin-persistedstate',
    'vuex-router-sync': 'vuex-router-sync does not work with Pinia — read the route from vue-router directly',
    'vuex-pathify': 'vuex-pathify is not migrated — replace it with direct Pinia store access',
    'vuex-map-fields': 'vuex-map-fields is not migrated — bind to the Pinia store state directly (it is writable)',
    'vuex-composition-helpers': 'vuex-composition-helpers is not migrated — use `storeToRefs()` from pinia',
    'direct-vuex': 'direct-vuex is not migrated — Pinia stores are typed out of the box',
};

export function migrate(options: MigrateOptions): MigrateResult {
    const fs = options.fs ?? nodeFileSystem;
    const storePath = resolve(options.storePath);
    const only = options.only;
    const enabled = (name: TransformName): boolean => !only || only.includes(name);

    const project = new Project(fs);
    const resolver = new PathResolver(fs, options.aliases ?? loadAliases(fs, dirname(storePath)));
    const report = new Reporter();

    const model = analyzeStore({ project, resolver, report }, storePath, { rootStoreId: options.rootStoreId });

    const refsByUnit = new Map<ScriptUnit, StoreRefs>();
    const ctx: MigrationContext = {
        project,
        resolver,
        report,
        model,
        refs(unit) {
            let refs = refsByUnit.get(unit);
            if (!refs) refsByUnit.set(unit, (refs = new StoreRefs(unit, resolver)));
            return refs;
        },
    };

    for (const unresolved of model.unresolved) {
        report.warn(unresolved.file, `module "${unresolved.pathSegments.join('/')}" was not migrated: ${unresolved.reason}`);
    }

    // Every file the analysis touched belongs to the store (modules, split getters/actions files, constants).
    const storeFiles = new Set(project.loaded().map((file) => file.path));

    if (enabled('store')) {
        convertStoreModules(ctx);
        convertRootFile(ctx);
    }

    const targets = new Set<string>(storeFiles);
    for (const file of options.files) targets.add(resolve(file));

    const results: FileResult[] = [];
    const remainingVuexFiles: string[] = [];

    for (const path of targets) {
        const file = project.load(path);
        if (!file) continue;

        if (file.error) {
            report.warn(file.path, `could not be parsed and was skipped: ${file.error}`);
            continue;
        }

        const kind = storeFiles.has(file.path) ? 'store' : 'source';
        let transformedSource: string;

        try {
            for (const unit of file.scripts) {
                project.refresh(unit);
                reportEcosystem(report, unit, false);
                if (enabled('map-helpers')) convertMapHelpers(ctx, unit);
                if (enabled('store-access')) convertStoreAccess(ctx, unit);
                if (enabled('vuex-class')) convertVuexClass(ctx, unit);
            }

            if (enabled('template')) convertTemplate(ctx, file);

            for (const unit of file.scripts) {
                ctx.refs(unit).finalize();
                removeOrphanedImports(unit);
                reportEcosystem(report, unit, true);
            }

            transformedSource = project.render(file);
        } catch (error) {
            // one odd file must not take the whole migration down
            const message = error instanceof Error ? error.message : String(error);
            report.warn(file.path, `could not be migrated and was left untouched: ${message}`);
            if (/from\s+['"]vuex['"]/.test(file.source)) remainingVuexFiles.push(file.path);
            results.push({ path: file.path, kind, originalSource: file.source, transformedSource: file.source, changed: false });
            continue;
        }

        if (stillImportsVuex(file)) remainingVuexFiles.push(file.path);

        results.push({
            path: file.path,
            kind,
            originalSource: file.source,
            transformedSource,
            changed: transformedSource !== file.source,
        });
    }

    return {
        stores: summarize(model),
        unresolvedModules: model.unresolved.map((u) => ({ path: u.pathSegments.join('/'), reason: u.reason, file: u.file })),
        files: results,
        messages: report.messages,
        remainingVuexFiles,
        vueVersion: model.vueVersion,
    };
}

function summarize(model: StoreModel): StoreSummary[] {
    return model.storeModules().map((module) => ({
        path: module.pathSegments.join('/'),
        storeId: module.storeId,
        exportName: module.exportName,
        file: module.def!.unit.file.path,
    }));
}

function stillImportsVuex(file: FileUnit): boolean {
    return file.scripts.some((unit) => importSources(unit).includes('vuex'));
}

/**
 * Libraries we cannot migrate are reported up front (their imports may vanish
 * together with the Vuex store); vuex-class only if something of it is left.
 */
function reportEcosystem(report: Reporter, unit: ScriptUnit, afterMigration: boolean): void {
    for (const source of importSources(unit)) {
        if ((source === 'vuex-class') !== afterMigration) continue;
        const message = VUEX_ECOSYSTEM[source];
        if (message) report.todo(unit.file.path, message);
    }
}
