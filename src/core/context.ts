import type { PathResolver } from './path-resolver.js';
import type { Project, ScriptUnit } from './project.js';
import type { Reporter } from './reporter.js';
import type { StoreModel } from './store-model.js';
import type { StoreRefs } from '../transforms/shared/store-refs.js';

/** Everything a transform needs to know about the project being migrated. */
export interface MigrationContext {
    project: Project;
    resolver: PathResolver;
    report: Reporter;
    model: StoreModel;
    /** Per-script bookkeeping of the Pinia stores a script ends up using. */
    refs(unit: ScriptUnit): StoreRefs;
}
