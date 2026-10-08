import type { NodePath, t } from './ast.js';
import type { ScriptUnit } from './project.js';

export type MemberKind = 'getters' | 'mutations' | 'actions';
export type PartKind = 'state' | MemberKind;

export interface MemberInfo {
    kind: MemberKind;
    /** Statically known key (null for computed keys that could not be evaluated). */
    name: string | null;
    /** Name the member has on the Pinia store (differs from `name` after a collision rename). */
    finalName: string | null;
    computed: boolean;
    /** The function itself; null when the value is not a function literal we can rewrite. */
    fnPath: NodePath<t.Function> | null;
    /** ObjectMethod / ObjectProperty / VariableDeclarator / FunctionDeclaration holding the function. */
    holderPath: NodePath;
    unit: ScriptUnit;
    isAsync: boolean;
    /** Removed from the generated store (identity getter, or action that only commits its twin mutation). */
    dropped: boolean;
    /** For dropped members: the name to use instead. */
    aliasOf?: string;
    /** True when the key can be renamed in place (it lives in an object literal). */
    renamable: boolean;
}

export type PartForm =
    /** `{ ... }` written directly in the module definition */
    | 'inline-object'
    /** function / arrow / method written directly in the module definition (state only) */
    | 'function'
    /** identifier that resolves to an object literal */
    | 'ident-object'
    /** identifier that resolves to a function (state only) */
    | 'ident-function'
    /** `import * as actions from './actions'` */
    | 'namespace'
    /** anything else (call expression, unresolvable identifier, ...) */
    | 'unknown';

export interface PartInfo {
    kind: PartKind;
    form: PartForm;
    /** Property inside the module object (absent for modules made of named exports). */
    propPath?: NodePath<t.ObjectProperty | t.ObjectMethod>;
    /** Identifier used to reference the part, if any. */
    ident?: string;
    /** Resolved object literal (may live in another file). */
    objectPath?: NodePath<t.ObjectExpression>;
    objectUnit?: ScriptUnit;
    /** Function providing the part (state factories). */
    fnPath?: NodePath<t.Function>;
    /** Module whose named exports make up the part (`import * as actions`). */
    namespaceUnit?: ScriptUnit;
    /** Local `const x = {...}` declarator that can be folded into the store definition. */
    inlineDeclarator?: NodePath<t.VariableDeclarator>;
    members: MemberInfo[];
}

export interface ModuleDef {
    unit: ScriptUnit;
    kind:
        /** `export default { ... }` */
        | 'export-default'
        /** `const cart = { ... }` (exported or referenced elsewhere) */
        | 'variable'
        /** object literal nested inside another module / the root store options */
        | 'inline'
        /** options object passed to `createStore` / `new Vuex.Store` */
        | 'root-options'
        /** file exporting `state`, `getters`, `mutations`, `actions` separately */
        | 'named-exports';
    objectPath?: NodePath<t.ObjectExpression>;
}

export interface ModuleInfo {
    /** Key under which the module is registered (empty for the root). */
    key: string;
    /** State path: every ancestor key, namespaced or not. */
    pathSegments: string[];
    parent: ModuleInfo | null;
    children: Map<string, ModuleInfo>;
    isRoot: boolean;
    namespaced: boolean;
    /** Vuex namespace prefix: '' or 'cart/' / 'cart/items/'. */
    namespace: string;
    def: ModuleDef | null;
    parts: Partial<Record<PartKind, PartInfo>>;
    stateKeys: Set<string>;
    /** False when the state shape could not be fully determined statically. */
    stateKeysComplete: boolean;
    /** True when a Pinia store is generated for this module. */
    hasStore: boolean;
    storeId: string;
    exportName: string;
    instanceName: string;
}

export interface UnresolvedModule {
    pathSegments: string[];
    reason: string;
    file: string;
}

export interface MemberTarget {
    module: ModuleInfo;
    /** Property name on the Pinia store. */
    name: string;
    member: MemberInfo | null;
}

export class StoreModel {
    root!: ModuleInfo;
    modules: ModuleInfo[] = [];
    unresolved: UnresolvedModule[] = [];
    rootFile = '';
    /** `createStore(...)` / `new Vuex.Store(...)` expression, when the root file has one. */
    creationPath: NodePath | null = null;
    /** Null for a Nuxt-style store directory without an index file. */
    rootUnit: ScriptUnit | null = null;
    /** Export names of the root file that evaluate to the store instance. */
    storeExports = new Set<string>();
    vueVersion: 2 | 3 = 3;

    private registry: Record<MemberKind, Map<string, { module: ModuleInfo; member: MemberInfo }[]>> = {
        getters: new Map(),
        mutations: new Map(),
        actions: new Map(),
    };

    register(kind: MemberKind, module: ModuleInfo, member: MemberInfo): void {
        if (member.name === null) return;
        const fullName = module.namespace + member.name;
        const list = this.registry[kind].get(fullName) ?? [];
        list.push({ module, member });
        this.registry[kind].set(fullName, list);
    }

    /** Resolves a full Vuex type (`cart/add`) to the store member(s) implementing it. */
    findMembers(kind: MemberKind, fullName: string): MemberTarget[] {
        const entries = this.registry[kind].get(fullName) ?? [];
        const targets: MemberTarget[] = [];

        for (const { module, member } of entries) {
            if (!module.hasStore) continue;
            targets.push({ module, member, name: member.dropped ? (member.aliasOf ?? member.name!) : member.finalName! });
        }
        if (targets.length > 0) return targets;

        // Not found statically (spread, dynamic registration, ...): trust the namespace prefix.
        const slash = fullName.lastIndexOf('/');
        const namespace = fullName.slice(0, slash + 1);
        const local = fullName.slice(slash + 1);
        const owners = this.modules.filter((m) => m.hasStore && m.namespace === namespace && this.mayDefine(m, kind));
        const owner = owners.length === 1 ? owners[0] : owners.find((m) => m.namespaced || m.isRoot);
        if (!owner || !local) return [];

        return [{ module: owner, member: null, name: local }];
    }

    /** A module may own members we could not see when its part is opaque (spread, call, import we can't follow). */
    private mayDefine(module: ModuleInfo, kind: MemberKind): boolean {
        const part = module.parts[kind];
        if (!part) return false;
        return part.form === 'unknown' || part.members.some((m) => m.name === null) || this.hasSpread(part);
    }

    private hasSpread(part: PartInfo): boolean {
        return part.objectPath?.node.properties.some((p) => p.type === 'SpreadElement') ?? false;
    }

    /** Module registered under a Vuex namespace (`''`, `cart/`, `cart/items/`). */
    moduleByNamespace(namespace: string): ModuleInfo | null {
        if (namespace === '') return this.root;
        return this.modules.find((m) => m.namespaced && m.namespace === namespace) ?? null;
    }

    storeModules(): ModuleInfo[] {
        return this.modules.filter((m) => m.hasStore);
    }
}

export function normalizeNamespace(namespace: string): string {
    if (namespace === '') return '';
    return namespace.endsWith('/') ? namespace : `${namespace}/`;
}
