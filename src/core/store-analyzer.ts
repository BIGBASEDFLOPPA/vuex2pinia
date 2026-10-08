import { dirname, join, resolve } from 'node:path';
import { isFunctionNode, isMemberLike, lineOf, staticKeyName, t, unwrapNode, unwrapPath, type NodePath } from './ast.js';
import { importedName } from './imports.js';
import type { ScriptUnit } from './project.js';
import type { Reporter } from './reporter.js';
import { exportedNames, getExport, resolveString, resolveValue, type ResolveEnv } from './resolve.js';
import {
    StoreModel,
    type MemberInfo,
    type MemberKind,
    type ModuleDef,
    type ModuleInfo,
    type PartInfo,
    type PartKind,
} from './store-model.js';
import { capitalize, toStoreExportName, toStoreInstanceName, uniqueName } from './store-naming.js';

export interface AnalyzeEnv extends ResolveEnv {
    report: Reporter;
}

export interface AnalyzeOptions {
    /** Id of the store generated from root-level state/getters/mutations/actions. */
    rootStoreId?: string;
}

const PART_KINDS: PartKind[] = ['state', 'getters', 'mutations', 'actions'];
const MEMBER_KINDS: MemberKind[] = ['getters', 'mutations', 'actions'];
const IGNORED_MODULE_KEYS = new Set(['namespaced', 'modules', 'strict', 'plugins', 'devtools']);

/** Builds the full picture of the Vuex store: module tree, namespaces and every getter/mutation/action. */
export function analyzeStore(env: AnalyzeEnv, storePath: string, options: AnalyzeOptions = {}): StoreModel {
    if (!env.project.fs.isFile(storePath) && env.project.fs.readDir(storePath)) {
        return analyzeStoreDirectory(env, resolve(storePath), options);
    }

    const rootUnit = env.project.moduleUnit(storePath);
    if (!rootUnit) {
        const file = env.project.load(storePath);
        throw new Error(file?.error ? `cannot parse ${storePath}: ${file.error}` : `store file not found: ${storePath}`);
    }

    const model = new StoreModel();
    model.rootFile = rootUnit.file.path;
    model.rootUnit = rootUnit;

    const builder = new ModelBuilder(env, model);
    const creation = findStoreCreation(rootUnit);

    if (creation) {
        model.creationPath = creation;
        const argument = (creation.get('arguments') as NodePath[])[0];
        const resolved = argument ? resolveValue(argument, rootUnit, env) : null;
        if (!resolved || resolved.kind !== 'value' || !resolved.path.isObjectExpression()) {
            throw new Error(`could not statically resolve the options passed to the Vuex store in ${storePath}`);
        }
        model.root = builder.fromObject(resolved.path, resolved.unit, [], null, '');
        collectStoreExports(model, creation);
    } else {
        const exported = getExport(rootUnit, 'default', env);
        if (exported?.kind === 'value' && exported.path.isObjectExpression()) {
            model.root = builder.fromObject(exported.path, exported.unit, [], null, '');
        } else if (hasPartExports(rootUnit, env)) {
            model.root = builder.fromNamedExports(rootUnit, [], null, '');
        } else {
            throw new Error(`no createStore() / new Vuex.Store() call or module object found in ${storePath}`);
        }
    }

    model.root.isRoot = true;
    model.root.namespace = '';
    finalizeModel(env, model, options);
    model.vueVersion = detectVueVersion(env, dirname(rootUnit.file.path), rootUnit);

    return model;
}

const MODULE_FILE = /^(.+)\.(?:[cm]?js|ts)$/;

/**
 * Nuxt 2 style store: a directory where every file is a namespaced module made
 * of `state` / `getters` / `mutations` / `actions` exports and `index` is the root.
 */
function analyzeStoreDirectory(env: AnalyzeEnv, directory: string, options: AnalyzeOptions): StoreModel {
    const model = new StoreModel();
    const builder = new ModelBuilder(env, model);

    const indexFile = ['index.js', 'index.ts', 'index.mjs'].map((name) => join(directory, name)).find((file) => env.project.fs.isFile(file));
    const indexUnit = indexFile ? env.project.moduleUnit(indexFile) : null;

    model.rootFile = indexFile ?? join(directory, 'index.js');
    model.rootUnit = indexUnit;
    model.root = indexUnit && hasPartExports(indexUnit, env) ? builder.fromNamedExports(indexUnit, [], null, '') : builder.emptyRoot();

    builder.fromDirectory(directory, model.root, true);

    model.root.isRoot = true;
    model.root.namespace = '';
    finalizeModel(env, model, options);
    model.vueVersion = detectVueVersion(env, directory, indexUnit);

    return model;
}

function isVuexBinding(path: NodePath<t.Identifier>, imported?: string): boolean {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) return false;
    const bindingPath = binding.path;
    const declaration = bindingPath.parent;
    if (!t.isImportDeclaration(declaration) || declaration.source.value !== 'vuex') return false;
    if (!imported) return bindingPath.isImportDefaultSpecifier() || bindingPath.isImportNamespaceSpecifier();
    return bindingPath.isImportSpecifier() && importedName(bindingPath.node) === imported;
}

function findStoreCreation(unit: ScriptUnit): NodePath<t.CallExpression | t.NewExpression> | null {
    let found: NodePath<t.CallExpression | t.NewExpression> | null = null;

    unit.program.traverse({
        CallExpression(path) {
            if (found) return;
            const callee = path.get('callee');
            if (callee.isIdentifier() && isVuexBinding(callee, 'createStore')) found = path;
            else if (
                callee.isMemberExpression() &&
                t.isIdentifier(callee.node.property, { name: 'createStore' }) &&
                callee.get('object').isIdentifier() &&
                isVuexBinding(callee.get('object') as NodePath<t.Identifier>)
            ) {
                found = path;
            }
        },
        NewExpression(path) {
            if (found) return;
            const callee = path.get('callee');
            if (callee.isIdentifier() && isVuexBinding(callee, 'Store')) found = path;
            else if (callee.isMemberExpression() && t.isIdentifier(callee.node.property, { name: 'Store' })) {
                const object = callee.get('object');
                if (object.isIdentifier() && (isVuexBinding(object) || object.node.name === 'Vuex')) found = path;
            }
        },
    });

    return found;
}

function collectStoreExports(model: StoreModel, creation: NodePath): void {
    let parent = creation.parentPath;
    while (parent && unwrapNode(parent.node) !== parent.node) parent = parent.parentPath;
    if (!parent) return;

    if (parent.isExportDefaultDeclaration()) {
        model.storeExports.add('default');
        return;
    }

    if (!parent.isVariableDeclarator() || !t.isIdentifier(parent.node.id)) return;
    const declaration = parent.parentPath;
    if (!declaration?.parentPath || !(declaration.parentPath.isProgram() || declaration.parentPath.isExportNamedDeclaration())) return;

    const localName = parent.node.id.name;
    if (declaration.parentPath.isExportNamedDeclaration()) model.storeExports.add(localName);

    for (const statement of model.rootUnit?.ast.program.body ?? []) {
        if (t.isExportDefaultDeclaration(statement) && t.isIdentifier(unwrapNode(statement.declaration), { name: localName })) {
            model.storeExports.add('default');
        }
        if (t.isExportNamedDeclaration(statement) && !statement.source) {
            for (const specifier of statement.specifiers) {
                if (!t.isExportSpecifier(specifier) || specifier.local.name !== localName) continue;
                model.storeExports.add(t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value);
            }
        }
    }
}

function hasPartExports(unit: ScriptUnit, env: ResolveEnv): boolean {
    const names = exportedNames(unit, env);
    return PART_KINDS.some((kind) => names.includes(kind));
}

class ModelBuilder {
    private seenObjects = new Set<t.Node>();
    private seenUnits = new Set<ScriptUnit>();

    constructor(
        private env: AnalyzeEnv,
        private model: StoreModel,
    ) {}

    private createModule(key: string, segments: string[], parent: ModuleInfo | null, namespaced: boolean, def: ModuleDef | null): ModuleInfo {
        const module: ModuleInfo = {
            key,
            pathSegments: segments,
            parent,
            children: new Map(),
            isRoot: parent === null,
            namespaced,
            namespace: parent ? parent.namespace + (namespaced ? `${key}/` : '') : '',
            def,
            parts: {},
            stateKeys: new Set(),
            stateKeysComplete: true,
            hasStore: false,
            storeId: '',
            exportName: '',
            instanceName: '',
        };
        this.model.modules.push(module);
        if (parent) parent.children.set(key, module);
        return module;
    }

    private unresolved(key: string, segments: string[], parent: ModuleInfo | null, unit: ScriptUnit, reason: string): ModuleInfo {
        this.model.unresolved.push({ pathSegments: segments, reason, file: unit.file.path });
        return this.createModule(key, segments, parent, true, null);
    }

    emptyRoot(): ModuleInfo {
        return this.createModule('', [], null, false, null);
    }

    /** Registers every module file of a Nuxt-style store directory below `parent`. */
    fromDirectory(directory: string, parent: ModuleInfo, isRootDirectory: boolean): void {
        const entries = [...(this.env.project.fs.readDir(directory) ?? [])].sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const path = join(directory, entry.name);

            if (entry.isDirectory) {
                const segments = [...parent.pathSegments, entry.name];
                const index = ['index.js', 'index.ts'].map((name) => join(path, name)).find((file) => this.env.project.fs.isFile(file));
                const indexUnit = index ? this.env.project.moduleUnit(index) : null;
                const module =
                    indexUnit && hasPartExports(indexUnit, this.env)
                        ? this.fromNamedExports(indexUnit, segments, parent, entry.name, true)
                        : this.createModule(entry.name, segments, parent, true, null);
                this.fromDirectory(path, module, false);
                continue;
            }

            const name = MODULE_FILE.exec(entry.name)?.[1];
            if (!name || name === 'index' || /\.(?:spec|test|d)$/.test(name)) continue;

            const segments = [...parent.pathSegments, name];
            const unit = this.env.project.moduleUnit(path);
            if (unit && hasPartExports(unit, this.env)) {
                this.fromNamedExports(unit, segments, parent, name, true);
            } else if (!isRootDirectory && ['state', 'getters', 'mutations', 'actions'].includes(name)) {
                this.model.unresolved.push({
                    pathSegments: segments,
                    reason: 'module split into state/getters/mutations/actions files inside a store directory — merge it into a Pinia store manually',
                    file: path,
                });
            }
        }
    }

    fromObject(
        objectPath: NodePath<t.ObjectExpression>,
        unit: ScriptUnit,
        segments: string[],
        parent: ModuleInfo | null,
        key: string,
    ): ModuleInfo {
        if (this.seenObjects.has(objectPath.node)) {
            return this.unresolved(key, segments, parent, unit, 'the same module object is registered more than once — only the first registration was migrated');
        }
        this.seenObjects.add(objectPath.node);

        const props = new Map<string, NodePath<t.ObjectProperty | t.ObjectMethod>>();
        for (const property of objectPath.get('properties')) {
            if (!property.isObjectProperty() && !property.isObjectMethod()) {
                this.env.report.warn(unit.file.path, `module "${segments.join('/') || 'root'}" spreads another object into its definition — the spread content was not migrated`, lineOf(property.node));
                continue;
            }
            const name = staticKeyName(property.node.key, property.node.computed);
            if (name !== null) props.set(name, property);
        }

        const namespacedProp = props.get('namespaced');
        const namespaced = !!namespacedProp?.isObjectProperty() && t.isBooleanLiteral(namespacedProp.node.value, { value: true });

        const module = this.createModule(key, segments, parent, namespaced, { unit, kind: defKind(objectPath), objectPath });

        for (const kind of PART_KINDS) {
            const property = props.get(kind);
            if (property) module.parts[kind] = this.resolvePart(kind, property, unit);
        }

        for (const name of props.keys()) {
            if (PART_KINDS.includes(name as PartKind) || IGNORED_MODULE_KEYS.has(name)) continue;
            this.env.report.warn(unit.file.path, `module "${segments.join('/') || 'root'}" has an unknown option "${name}" — it was dropped`, lineOf(props.get(name)?.node));
        }

        const modulesProp = props.get('modules');
        if (modulesProp?.isObjectProperty()) this.collectChildren(module, modulesProp.get('value') as NodePath, unit);

        return module;
    }

    fromNamedExports(unit: ScriptUnit, segments: string[], parent: ModuleInfo | null, key: string, forceNamespaced = false): ModuleInfo {
        if (this.seenUnits.has(unit)) {
            return this.unresolved(key, segments, parent, unit, 'the same module file is registered more than once — only the first registration was migrated');
        }
        this.seenUnits.add(unit);

        const namespacedExport = getExport(unit, 'namespaced', this.env);
        const namespaced =
            forceNamespaced || (namespacedExport?.kind === 'value' && t.isBooleanLiteral(namespacedExport.path.node, { value: true }));

        const module = this.createModule(key, segments, parent, namespaced, { unit, kind: 'named-exports' });

        for (const kind of PART_KINDS) {
            const resolved = getExport(unit, kind, this.env);
            if (!resolved || resolved.kind !== 'value') continue;

            const part: PartInfo = { kind, form: 'unknown', ident: kind, members: [] };
            if (resolved.path.isObjectExpression()) {
                part.form = 'ident-object';
                part.objectPath = resolved.path;
                part.objectUnit = resolved.unit;
                if (kind !== 'state') this.collectMembers(resolved.path, resolved.unit, kind, part.members);
            } else if (isFunctionNode(resolved.path.node)) {
                part.form = 'ident-function';
                part.fnPath = resolved.path as NodePath<t.Function>;
            }
            module.parts[kind] = part;
        }

        const modules = getExport(unit, 'modules', this.env);
        if (modules?.kind === 'value') this.collectChildren(module, modules.path, modules.unit);

        return module;
    }

    private resolvePart(kind: PartKind, propPath: NodePath<t.ObjectProperty | t.ObjectMethod>, unit: ScriptUnit): PartInfo {
        const part: PartInfo = { kind, form: 'unknown', propPath, members: [] };

        if (propPath.isObjectMethod()) {
            part.form = 'function';
            part.fnPath = propPath;
            return part;
        }

        const value = unwrapPath(propPath.get('value') as NodePath);

        if (value.isObjectExpression()) {
            part.form = 'inline-object';
            part.objectPath = value;
            part.objectUnit = unit;
        } else if (isFunctionNode(value.node)) {
            part.form = 'function';
            part.fnPath = value as NodePath<t.Function>;
        } else if (value.isIdentifier() || isMemberLike(value.node)) {
            if (value.isIdentifier()) part.ident = value.node.name;
            const resolved = resolveValue(value, unit, this.env);

            if (resolved?.kind === 'namespace') {
                part.form = 'namespace';
                part.namespaceUnit = resolved.unit;
            } else if (resolved?.kind === 'value' && resolved.path.isObjectExpression()) {
                part.form = 'ident-object';
                part.objectPath = resolved.path;
                part.objectUnit = resolved.unit;
            } else if (resolved?.kind === 'value' && isFunctionNode(resolved.path.node)) {
                part.form = 'ident-function';
                part.fnPath = resolved.path as NodePath<t.Function>;
            }

            if (value.isIdentifier() && resolved?.kind === 'value' && resolved.unit === unit) {
                part.inlineDeclarator = inlineableDeclarator(value, resolved.path) ?? undefined;
            }
        }

        if (kind !== 'state') {
            if (part.objectPath && part.objectUnit) this.collectMembers(part.objectPath, part.objectUnit, kind, part.members);
            else if (part.namespaceUnit) this.collectNamespaceMembers(part.namespaceUnit, kind, part.members);
            else {
                this.env.report.warn(unit.file.path, `"${kind}" could not be resolved to an object literal — its content was not migrated`, lineOf(propPath.node));
            }
        }

        return part;
    }

    private collectMembers(objectPath: NodePath<t.ObjectExpression>, unit: ScriptUnit, kind: MemberKind, out: MemberInfo[], depth = 0): void {
        for (const property of objectPath.get('properties')) {
            if (property.isSpreadElement()) {
                const resolved = depth < 5 ? resolveValue(property.get('argument') as NodePath, unit, this.env) : null;
                if (resolved?.kind === 'value' && resolved.path.isObjectExpression()) {
                    this.collectMembers(resolved.path, resolved.unit, kind, out, depth + 1);
                } else if (resolved?.kind === 'namespace') {
                    this.collectNamespaceMembers(resolved.unit, kind, out);
                } else {
                    this.env.report.warn(unit.file.path, `${kind}: spread element could not be resolved — migrate the spread ${kind} manually`, lineOf(property.node));
                }
                continue;
            }

            if (!property.isObjectProperty() && !property.isObjectMethod()) continue;

            const keyPath = property.get('key') as NodePath;
            const name =
                staticKeyName(property.node.key, property.node.computed) ??
                (property.node.computed ? resolveString(keyPath, unit, this.env) : null);

            const member: MemberInfo = {
                kind,
                name,
                finalName: name,
                computed: property.node.computed && !t.isStringLiteral(property.node.key),
                fnPath: null,
                holderPath: property,
                unit,
                isAsync: false,
                dropped: false,
                renamable: depth === 0,
            };

            if (property.isObjectMethod()) {
                member.fnPath = property;
            } else {
                const value = unwrapPath(property.get('value') as NodePath);
                if (isFunctionNode(value.node)) {
                    member.fnPath = value as NodePath<t.Function>;
                } else {
                    const resolved = resolveValue(value, unit, this.env);
                    if (resolved?.kind === 'value' && isFunctionNode(resolved.path.node)) {
                        member.fnPath = resolved.path as NodePath<t.Function>;
                        member.unit = resolved.unit;
                    }
                }
            }

            if (!member.fnPath) {
                this.env.report.warn(unit.file.path, `${kind}: "${name ?? '<computed>'}" is not a function literal — migrate it manually`, lineOf(property.node));
            } else {
                member.isAsync = !!member.fnPath.node.async;
            }
            if (name === null) {
                this.env.report.warn(unit.file.path, `${kind}: computed key could not be evaluated statically — calls to it cannot be migrated automatically`, lineOf(property.node));
            }

            out.push(member);
        }
    }

    private collectNamespaceMembers(unit: ScriptUnit, kind: MemberKind, out: MemberInfo[]): void {
        for (const name of exportedNames(unit, this.env)) {
            const resolved = getExport(unit, name, this.env);
            if (!resolved || resolved.kind !== 'value' || !isFunctionNode(resolved.path.node)) continue;
            out.push({
                kind,
                name,
                finalName: name,
                computed: false,
                fnPath: resolved.path as NodePath<t.Function>,
                holderPath: resolved.path,
                unit: resolved.unit,
                isAsync: !!(resolved.path.node as t.Function).async,
                dropped: false,
                renamable: false,
            });
        }
    }

    private collectChildren(parent: ModuleInfo, valuePath: NodePath, unit: ScriptUnit): void {
        const resolved = resolveValue(valuePath, unit, this.env);

        if (resolved?.kind === 'namespace') {
            for (const name of exportedNames(resolved.unit, this.env)) {
                const exported = getExport(resolved.unit, name, this.env);
                this.addChild(parent, name, exported, resolved.unit);
            }
            return;
        }

        if (!resolved || !resolved.path.isObjectExpression()) {
            this.model.unresolved.push({
                pathSegments: [...parent.pathSegments, '*'],
                reason: '"modules" is not a static object (dynamic registration, require.context, import.meta.glob?) — its modules were not migrated',
                file: unit.file.path,
            });
            return;
        }

        for (const property of resolved.path.get('properties')) {
            if (property.isSpreadElement()) {
                const spread = resolveValue(property.get('argument') as NodePath, resolved.unit, this.env);
                if (spread && (spread.kind === 'namespace' || spread.path.isObjectExpression())) {
                    this.collectChildren(parent, property.get('argument') as NodePath, resolved.unit);
                } else {
                    this.model.unresolved.push({
                        pathSegments: [...parent.pathSegments, '...'],
                        reason: 'spread inside "modules" could not be resolved',
                        file: resolved.unit.file.path,
                    });
                }
                continue;
            }

            if (!property.isObjectProperty()) continue;
            const key =
                staticKeyName(property.node.key, property.node.computed) ??
                resolveString(property.get('key') as NodePath, resolved.unit, this.env);
            if (key === null) {
                this.model.unresolved.push({
                    pathSegments: [...parent.pathSegments, '<computed>'],
                    reason: 'module is registered under a computed key that could not be evaluated',
                    file: resolved.unit.file.path,
                });
                continue;
            }

            const child = resolveValue(property.get('value') as NodePath, resolved.unit, this.env);
            this.addChild(parent, key, child, resolved.unit);
        }
    }

    private addChild(parent: ModuleInfo, key: string, resolved: ReturnType<typeof resolveValue>, unit: ScriptUnit): void {
        const segments = [...parent.pathSegments, key];

        if (resolved?.kind === 'namespace') {
            if (hasPartExports(resolved.unit, this.env)) this.fromNamedExports(resolved.unit, segments, parent, key);
            else this.unresolved(key, segments, parent, unit, `"${key}" is a namespace import without state/getters/mutations/actions exports`);
            return;
        }

        if (resolved?.kind === 'value' && resolved.path.isObjectExpression()) {
            this.fromObject(resolved.path, resolved.unit, segments, parent, key);
            return;
        }

        const reason = !resolved
            ? `"${key}" could not be traced to a module definition (unresolvable import or identifier)`
            : `"${key}" is not an object literal (module factory or dynamic value?) — handle manually`;
        this.unresolved(key, segments, parent, unit, reason);
    }
}

function defKind(objectPath: NodePath<t.ObjectExpression>): ModuleDef['kind'] {
    let child: NodePath = objectPath;
    let parent: NodePath | null = objectPath.parentPath;
    while (parent && unwrapNode(parent.node) !== parent.node) {
        child = parent;
        parent = parent.parentPath;
    }
    if (!parent) return 'inline';

    if (parent.isExportDefaultDeclaration()) return 'export-default';

    if (parent.isVariableDeclarator() && child.key === 'init' && t.isIdentifier(parent.node.id)) {
        const declaration = parent.parentPath;
        const holder = declaration?.parentPath;
        const single = t.isVariableDeclaration(declaration?.node) && declaration.node.declarations.length === 1;
        if (single && holder && (holder.isProgram() || holder.isExportNamedDeclaration())) return 'variable';
    }

    return 'inline';
}

/** A non-exported top-level `const x = ...` that is referenced exactly once can be folded into the store. */
function inlineableDeclarator(identifier: NodePath<t.Identifier>, resolvedPath: NodePath): NodePath<t.VariableDeclarator> | null {
    const binding = identifier.scope.getBinding(identifier.node.name);
    if (!binding || !binding.path.isVariableDeclarator()) return null;
    if (binding.referencePaths.length !== 1 || binding.constantViolations.length > 0) return null;

    const declarator = binding.path;
    const init = declarator.get('init');
    if (!init.node || unwrapPath(init as NodePath).node !== resolvedPath.node) return null;

    const declaration = declarator.parentPath;
    if (!declaration.isVariableDeclaration() || declaration.node.declarations.length !== 1) return null;
    if (!declaration.parentPath.isProgram()) return null;

    return declarator;
}

function finalizeModel(env: AnalyzeEnv, model: StoreModel, options: AnalyzeOptions): void {
    for (const module of model.modules) {
        module.hasStore = module.def !== null && Object.keys(module.parts).length > 0;
        collectStateKeys(module);
    }

    // names
    const taken = new Set<string>();
    for (const module of model.modules) {
        if (module.isRoot) continue;
        module.storeId = module.pathSegments.join('/');
        module.exportName = uniqueName(toStoreExportName(module.pathSegments), (n) => taken.has(n));
        module.instanceName = toStoreInstanceName(module.exportName);
        taken.add(module.exportName);
    }

    let rootId = options.rootStoreId ?? 'root';
    if (taken.has(toStoreExportName([rootId])) || model.modules.some((m) => !m.isRoot && m.storeId === rootId)) {
        rootId = rootId === 'main' ? 'app' : 'main';
    }
    model.root.storeId = rootId;
    model.root.exportName = uniqueName(toStoreExportName([rootId]), (n) => taken.has(n));
    model.root.instanceName = toStoreInstanceName(model.root.exportName);

    for (const module of model.modules) {
        if (!module.hasStore) continue;
        resolveCollisions(env, module);
        for (const kind of MEMBER_KINDS) {
            for (const member of module.parts[kind]?.members ?? []) model.register(kind, module, member);
        }
    }
}

function returnedObject(fnPath: NodePath<t.Function>): NodePath<t.ObjectExpression> | null {
    const body = fnPath.get('body') as NodePath;
    if (!body.isBlockStatement()) {
        const expression = unwrapPath(body);
        return expression.isObjectExpression() ? expression : null;
    }

    const statements = body.get('body');
    const last = statements[statements.length - 1];
    if (!last?.isReturnStatement() || !last.node.argument) return null;
    const argument = unwrapPath(last.get('argument') as NodePath);
    return argument.isObjectExpression() ? argument : null;
}

function collectStateKeys(module: ModuleInfo): void {
    const part = module.parts.state;
    if (!part) return;

    const objectPath = part.objectPath ?? (part.fnPath ? returnedObject(part.fnPath) : null);
    if (!objectPath) {
        module.stateKeysComplete = false;
        return;
    }

    for (const property of objectPath.node.properties) {
        const name = t.isSpreadElement(property) ? null : staticKeyName(property.key, property.computed);
        if (name === null) module.stateKeysComplete = false;
        else module.stateKeys.add(name);
    }
}

function isIdentityGetter(member: MemberInfo): boolean {
    const fn = member.fnPath?.node;
    if (!fn) return false;
    const [stateParam] = fn.params;
    if (!t.isIdentifier(stateParam)) return false;

    let expression: t.Node | null | undefined = fn.body;
    if (t.isBlockStatement(expression)) {
        const [statement] = expression.body;
        if (expression.body.length !== 1 || !t.isReturnStatement(statement)) return false;
        expression = statement.argument;
    }
    if (!expression) return false;

    expression = unwrapNode(expression);
    return (
        t.isMemberExpression(expression) &&
        t.isIdentifier(expression.object, { name: stateParam.name }) &&
        staticKeyName(expression.property, expression.computed) === member.name
    );
}

/** `setUser({ commit }, user) { commit('setUser', user) }` — an action that only forwards to its twin mutation. */
function isForwardingAction(member: MemberInfo): boolean {
    const fn = member.fnPath?.node;
    if (!fn || fn.params.length > 2) return false;
    const [contextParam, payloadParam] = fn.params;

    let expression: t.Node | null | undefined = fn.body;
    if (t.isBlockStatement(expression)) {
        const [statement] = expression.body;
        if (expression.body.length !== 1) return false;
        if (t.isExpressionStatement(statement)) expression = statement.expression;
        else if (t.isReturnStatement(statement)) expression = statement.argument;
        else return false;
    }
    if (!t.isCallExpression(expression)) return false;

    const callee = expression.callee;
    let isCommit = false;
    if (t.isObjectPattern(contextParam) && t.isIdentifier(callee)) {
        isCommit = contextParam.properties.some(
            (p) => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: 'commit' }) && t.isIdentifier(p.value, { name: callee.name }),
        );
    } else if (t.isIdentifier(contextParam) && t.isMemberExpression(callee)) {
        isCommit = t.isIdentifier(callee.object, { name: contextParam.name }) && t.isIdentifier(callee.property, { name: 'commit' });
    }
    if (!isCommit) return false;

    const [type, payload, extra] = expression.arguments;
    if (extra || !t.isStringLiteral(type, { value: member.name ?? '' })) return false;
    if (!payload) return true;
    return t.isIdentifier(payload) && t.isIdentifier(payloadParam, { name: payload.name });
}

/** Pinia keeps state, getters and actions in one namespace — Vuex did not. */
function resolveCollisions(env: AnalyzeEnv, module: ModuleInfo): void {
    const getters = module.parts.getters?.members ?? [];
    const mutations = module.parts.mutations?.members ?? [];
    const actions = module.parts.actions?.members ?? [];
    const file = module.def!.unit.file.path;
    const label = `store "${module.storeId}"`;

    const isTaken = (name: string): boolean =>
        module.stateKeys.has(name) ||
        [...getters, ...mutations, ...actions].some((m) => !m.dropped && m.finalName === name);

    const rename = (member: MemberInfo, candidates: string[], reason: string): void => {
        if (!member.renamable || member.computed) {
            env.report.warn(file, `${label}: ${member.kind.slice(0, -1)} "${member.name}" ${reason}, and could not be renamed automatically — rename it manually`, lineOf(member.holderPath.node));
            return;
        }
        const free = candidates.find((c) => !isTaken(c));
        member.finalName = free ?? uniqueName(candidates[candidates.length - 1]!, isTaken);
        env.report.info(file, `${label}: ${member.kind.slice(0, -1)} "${member.name}" was renamed to "${member.finalName}" (${reason})`, lineOf(member.holderPath.node));
    };

    for (const getter of getters) {
        if (getter.name === null || !module.stateKeys.has(getter.name)) continue;
        if (isIdentityGetter(getter) && getter.renamable) {
            getter.dropped = true;
            getter.aliasOf = getter.name;
            env.report.info(file, `${label}: getter "${getter.name}" only returned the state property of the same name and was removed`, lineOf(getter.holderPath.node));
        } else {
            rename(getter, [`${getter.name}Getter`], 'has the same name as a state property');
        }
    }

    const forwarded: { action: MemberInfo; mutation: MemberInfo }[] = [];
    for (const action of actions) {
        if (action.name === null) continue;
        const mutation = mutations.find((m) => m.name === action.name);
        if (!mutation) continue;

        if (isForwardingAction(action) && action.renamable) {
            action.dropped = true;
            forwarded.push({ action, mutation });
            env.report.info(file, `${label}: action "${action.name}" only committed the mutation of the same name and was merged into it`, lineOf(action.holderPath.node));
        } else if (mutation.renamable && !mutation.computed) {
            rename(mutation, [`${mutation.name}Mutation`], 'has the same name as an action');
        } else {
            rename(action, [`${action.name}Action`], 'has the same name as a mutation');
        }
    }

    for (const member of [...mutations, ...actions]) {
        if (member.dropped || member.finalName === null) continue;
        const name = member.finalName;
        const clashesWithState = module.stateKeys.has(name);
        const clashesWithGetter = getters.some((g) => !g.dropped && g.finalName === name);
        if (!clashesWithState && !clashesWithGetter) continue;

        const suffix = member.kind === 'mutations' ? 'Mutation' : 'Action';
        const candidates = member.kind === 'mutations' && clashesWithState ? [`set${capitalize(name)}`, `${name}${suffix}`] : [`${name}${suffix}`];
        rename(member, candidates, `has the same name as a ${clashesWithState ? 'state property' : 'getter'}`);
    }

    for (const { action, mutation } of forwarded) action.aliasOf = mutation.finalName ?? mutation.name ?? undefined;
}

function detectVueVersion(env: AnalyzeEnv, startDir: string, rootUnit: ScriptUnit | null): 2 | 3 {
    let dir = startDir;
    for (;;) {
        const content = env.project.fs.readFile(join(dir, 'package.json'));
        if (content !== undefined) {
            try {
                const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
                const deps = { ...pkg.devDependencies, ...pkg.dependencies };
                const major = (range: string | undefined): number | null => {
                    const match = /(\d+)\./.exec(range ?? '');
                    return match?.[1] ? Number(match[1]) : null;
                };
                const vue = major(deps.vue);
                const vuex = major(deps.vuex);
                if (vue !== null) return vue <= 2 ? 2 : 3;
                if (vuex !== null) return vuex <= 3 ? 2 : 3;
            } catch {
                // fall through to the heuristic below
            }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // `Vue.use(Vuex)` only exists in Vue 2 projects
    let usesGlobalInstall = false;
    if (!rootUnit) return 3;
    t.traverseFast(rootUnit.ast, (node) => {
        if (
            t.isCallExpression(node) &&
            t.isMemberExpression(node.callee) &&
            t.isIdentifier(node.callee.object, { name: 'Vue' }) &&
            t.isIdentifier(node.callee.property, { name: 'use' })
        ) {
            usesGlobalInstall = true;
        }
    });
    return usesGlobalInstall ? 2 : 3;
}
