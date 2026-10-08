import { TODO_PREFIX, addLeadingComment, compactExpression, moveComments, objectKey, staticKeyName, t, unwrapPath, isFunctionNode, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import { ensureNamedImport, importedName, importsFrom } from '../../core/imports.js';
import type { ScriptUnit } from '../../core/project.js';
import { resolveString } from '../../core/resolve.js';
import { normalizeNamespace, type MemberKind, type ModuleInfo } from '../../core/store-model.js';
import { capitalize } from '../../core/store-naming.js';
import { placeInFunction } from '../shared/placement.js';
import { Rewriter } from '../shared/rewriter.js';

type VuexHelper = 'mapState' | 'mapGetters' | 'mapMutations' | 'mapActions';
type PiniaHelper = 'mapState' | 'mapActions';

const HELPERS: Record<VuexHelper, { pinia: PiniaHelper; kind: MemberKind | 'state' }> = {
    mapState: { pinia: 'mapState', kind: 'state' },
    mapGetters: { pinia: 'mapState', kind: 'getters' },
    mapMutations: { pinia: 'mapActions', kind: 'mutations' },
    mapActions: { pinia: 'mapActions', kind: 'actions' },
};

function isHelper(name: string | null): name is VuexHelper {
    return name !== null && name in HELPERS;
}

interface HelperSite {
    call: NodePath<t.CallExpression>;
    helper: VuexHelper;
    fixedNamespace?: string;
    importLocal?: string;
}

interface Entry {
    alias: string;
    name?: string;
    fnPath?: NodePath<t.Function>;
}

interface GroupItem {
    alias: string;
    key?: string;
    fn?: t.Expression | t.ObjectMethod;
}

type ObjectMember = t.ObjectMethod | t.ObjectProperty | t.SpreadElement;

export function convertMapHelpers(ctx: MigrationContext, unit: ScriptUnit): void {
    new MapHelperConverter(ctx, unit).run();
}

class MapHelperConverter {
    private sites: HelperSite[] = [];
    private leftovers = new Map<string, t.Identifier[]>();
    private importLocals = new Set<string>();
    private neededPinia = new Set<PiniaHelper>();
    private namespacedDeclarators: { declarator: NodePath<t.VariableDeclarator>; sites: HelperSite[]; complete: boolean }[] = [];

    constructor(
        private ctx: MigrationContext,
        private unit: ScriptUnit,
    ) {}

    run(): void {
        const vuexImports = importsFrom(this.unit, 'vuex');
        if (vuexImports.length === 0) return;

        this.collectSites(vuexImports);
        if (this.sites.length === 0 && this.importLocals.size === 0) return;

        const results = new Map<HelperSite, boolean>();
        for (const site of this.sites) results.set(site, this.convertSite(site));

        for (const entry of this.namespacedDeclarators) {
            if (!entry.complete || !entry.sites.every((site) => results.get(site))) continue;
            const declaration = entry.declarator.parentPath;
            if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 1) declaration.remove();
            else entry.declarator.remove();
        }

        this.fixImports(vuexImports);
    }


    private collectSites(vuexImports: t.ImportDeclaration[]): void {
        const scope = this.unit.program.scope;

        for (const declaration of vuexImports) {
            for (const specifier of declaration.specifiers) {
                const binding = scope.getBinding(specifier.local.name);
                if (!binding) continue;

                if (t.isImportSpecifier(specifier)) {
                    const imported = importedName(specifier);
                    if (isHelper(imported)) {
                        this.importLocals.add(specifier.local.name);
                        for (const reference of binding.referencePaths) {
                            const call = reference.parentPath;
                            if (call?.isCallExpression() && call.node.callee === reference.node) {
                                this.sites.push({ call, helper: imported, importLocal: specifier.local.name });
                            } else {
                                this.addLeftover(specifier.local.name, reference.node as t.Identifier);
                            }
                        }
                    } else if (imported === 'createNamespacedHelpers') {
                        for (const reference of binding.referencePaths) this.collectNamespaced(reference);
                    }
                    continue;
                }

                for (const reference of binding.referencePaths) {
                    const member = reference.parentPath;
                    if (!member?.isMemberExpression() || member.node.object !== reference.node) continue;
                    const name = staticKeyName(member.node.property, member.node.computed);
                    const call = member.parentPath;
                    if (!call?.isCallExpression() || call.node.callee !== member.node) continue;

                    if (isHelper(name)) this.sites.push({ call, helper: name });
                    else if (name === 'createNamespacedHelpers') this.collectNamespaced(member);
                }
            }
        }
    }

    private collectNamespaced(calleePath: NodePath): void {
        const call = calleePath.parentPath;
        if (!call?.isCallExpression() || call.node.callee !== calleePath.node) return;

        const [argument] = call.get('arguments');
        const namespace = argument ? resolveString(argument, this.unit, this.ctx) : null;
        const declarator = call.parentPath;
        if (namespace === null || !declarator?.isVariableDeclarator()) {
            this.todo(call, 'createNamespacedHelpers() could not be analysed — convert the helpers created from it manually');
            return;
        }

        const fixedNamespace = normalizeNamespace(namespace);
        const entry = { declarator, sites: [] as HelperSite[], complete: true };
        this.namespacedDeclarators.push(entry);

        const addSites = (binding: ReturnType<NodePath['scope']['getBinding']>, helper: VuexHelper | null): void => {
            for (const reference of binding?.referencePaths ?? []) {
                let callee: NodePath = reference;
                let name: VuexHelper | null = helper;
                if (!name) {
                    const member = reference.parentPath;
                    const key = member?.isMemberExpression() && member.node.object === reference.node ? staticKeyName(member.node.property, member.node.computed) : null;
                    if (!member || !isHelper(key)) {
                        entry.complete = false;
                        continue;
                    }
                    callee = member;
                    name = key;
                }
                const helperCall = callee.parentPath;
                if (helperCall?.isCallExpression() && helperCall.node.callee === callee.node) {
                    const site: HelperSite = { call: helperCall, helper: name, fixedNamespace };
                    this.sites.push(site);
                    entry.sites.push(site);
                } else {
                    entry.complete = false;
                }
            }
        };

        const id = declarator.get('id');
        if (id.isIdentifier()) {
            addSites(declarator.scope.getBinding(id.node.name), null);
        } else if (id.isObjectPattern()) {
            for (const property of id.node.properties) {
                const key = t.isObjectProperty(property) ? staticKeyName(property.key, property.computed) : null;
                if (!t.isObjectProperty(property) || !isHelper(key) || !t.isIdentifier(property.value)) {
                    entry.complete = false;
                    continue;
                }
                addSites(declarator.scope.getBinding(property.value.name), key);
            }
        } else {
            entry.complete = false;
        }
    }

    private addLeftover(local: string, identifier: t.Identifier): void {
        const list = this.leftovers.get(local) ?? [];
        list.push(identifier);
        this.leftovers.set(local, list);
    }

    private todo(path: NodePath, message: string): void {
        const anchor = path.find((p) => p.isStatement() || ((p.isSpreadElement() || p.isObjectProperty()) && !!p.parentPath?.isObjectExpression())) ?? path;
        addLeadingComment(anchor.node, `${TODO_PREFIX}: ${message}`);
        this.ctx.report.todo(this.unit.file.path, message, this.line(path.node));
    }

    private line(node: t.Node): number | undefined {
        const line = node.loc?.start.line;
        if (line === undefined) return undefined;
        return this.unit.start === 0 ? line : line + this.unit.file.source.slice(0, this.unit.start).split('\n').length - 1;
    }


    private fail(site: HelperSite, message: string): false {
        this.todo(site.call, message);
        if (site.importLocal && t.isIdentifier(site.call.node.callee)) this.addLeftover(site.importLocal, site.call.node.callee);
        return false;
    }

    private convertSite(site: HelperSite): boolean {
        const { call, helper } = site;
        const args = call.get('arguments') as NodePath[];

        let namespace = site.fixedNamespace ?? '';
        let mapArg = args[0];
        if (site.fixedNamespace === undefined && args.length >= 2) {
            const resolved = resolveString(args[0]!, this.unit, this.ctx);
            if (resolved === null) return this.fail(site, `${helper}(): the namespace is not a static string — convert this call manually`);
            namespace = normalizeNamespace(resolved);
            mapArg = args[1];
        }

        const entries = mapArg ? this.extractEntries(unwrapPath(mapArg)) : null;
        if (!mapArg || !entries) return this.fail(site, `${helper}(): the mapping is not a static array/object — convert this call manually`);

        const groups = new Map<ModuleInfo, GroupItem[]>();
        const plain: t.ObjectMethod[] = [];
        const leftover: Entry[] = [];
        const group = (module: ModuleInfo, item: GroupItem): void => {
            const list = groups.get(module) ?? [];
            list.push(item);
            groups.set(module, list);
        };
        const refs = this.ctx.refs(this.unit);
        const { model } = this.ctx;
        const kind = HELPERS[helper].kind;
        let renamed = false;

        if (kind === 'state') {
            const base = model.moduleByNamespace(namespace);
            if (!base) {
                const path = namespace.replace(/\/$/, '');
                const plain = model.modules.find((module) => !module.namespaced && module.pathSegments.join('/') === path);
                const reason = plain
                    ? `module "${path}" is not namespaced, so "${path}" is not a valid namespace in Vuex either`
                    : `no module is registered under the namespace "${path}"`;
                return this.fail(site, `${helper}(): ${reason} — convert this call manually`);
            }

            for (const entry of entries) {
                if (entry.name !== undefined) {
                    const child = base.children.get(entry.name);
                    if (child?.hasStore) {
                        // the entry maps the whole state of a nested module
                        const body = t.blockStatement([t.returnStatement(t.memberExpression(refs.inline(child), t.identifier('$state')))]);
                        plain.push(t.objectMethod('method', objectKey(entry.alias), [], body));
                    } else if (!child && base.hasStore) {
                        if (base.stateKeysComplete && !base.stateKeys.has(entry.name)) {
                            this.ctx.report.warn(this.unit.file.path, `${helper}(): "${entry.name}" is not a state property declared by store "${base.storeId}"`, this.line(call.node));
                        }
                        group(base, { alias: entry.alias, key: entry.name });
                    } else {
                        leftover.push(entry);
                    }
                } else if (entry.fnPath) {
                    if (this.readsOnlyOwnState(entry.fnPath, base)) group(base, { alias: entry.alias, fn: entry.fnPath.node as t.Expression | t.ObjectMethod });
                    else plain.push(this.toPlainMethod(entry, base, namespace));
                }
            }
        } else {
            for (const entry of entries) {
                if (entry.name === undefined) {
                    leftover.push(entry);
                    continue;
                }
                const targets = model.findMembers(kind, namespace + entry.name);
                const [target] = targets;
                if (!target) {
                    leftover.push(entry);
                    continue;
                }
                if (targets.length > 1) {
                    this.ctx.report.warn(this.unit.file.path, `${helper}(): "${namespace}${entry.name}" is handled by ${targets.length} non-namespaced modules — only store "${target.module.storeId}" is mapped now`, this.line(call.node));
                }
                if (!target.member) {
                    this.ctx.report.warn(this.unit.file.path, `${helper}(): "${namespace}${entry.name}" is not declared statically — assumed to exist on store "${target.module.storeId}"`, this.line(call.node));
                }
                if (target.name !== entry.name) renamed = true;
                group(target.module, { alias: entry.alias, key: target.name });
            }
        }

        if (groups.size === 0 && plain.length === 0) {
            return this.fail(site, `${helper}(): ${leftover.map((e) => `"${namespace}${e.name ?? e.alias}"`).join(', ')} could not be matched to a Pinia store — convert this call manually`);
        }

        const piniaHelper = HELPERS[helper].pinia;
        if (groups.size > 0) this.neededPinia.add(piniaHelper);
        for (const module of groups.keys()) refs.use(module);

        const [singleGroup] = [...groups];
        if (groups.size === 1 && singleGroup && plain.length === 0 && leftover.length === 0 && !renamed) {
            call.node.callee = t.identifier(piniaHelper);
            call.node.arguments = [t.identifier(singleGroup[0].exportName), mapArg.node as t.Expression];
            return true;
        }

        const members: ObjectMember[] = [];
        for (const [module, items] of groups) {
            const simple = items.every((item) => item.key !== undefined && item.key === item.alias);
            const mapping = simple
                ? t.arrayExpression(items.map((item) => t.stringLiteral(item.key!)))
                : items.some((item) => item.fn)
                  ? t.objectExpression(
                        items.map((item) => {
                            if (item.fn && t.isObjectMethod(item.fn)) return item.fn;
                            return t.objectProperty(objectKey(item.alias), item.fn ?? t.stringLiteral(item.key!));
                        }),
                    )
                  : compactExpression(
                        t.objectExpression(items.map((item) => t.objectProperty(objectKey(item.alias), t.stringLiteral(item.key!)))),
                    );
            members.push(t.spreadElement(t.callExpression(t.identifier(piniaHelper), [t.identifier(module.exportName), mapping])));
        }
        members.push(...plain);

        if (leftover.length > 0) {
            const message = `${helper}(): ${leftover.map((e) => `"${namespace}${e.name ?? e.alias}"`).join(', ')} could not be matched to a Pinia store — convert manually`;
            const residualCallee = t.cloneNode(call.node.callee);
            const residualArgs: t.Expression[] = [];
            if (site.fixedNamespace === undefined && args.length >= 2) residualArgs.push(t.cloneNode(args[0]!.node as t.Expression));
            residualArgs.push(this.residualMapping(unwrapPath(mapArg), leftover));
            const residual = t.spreadElement(t.callExpression(residualCallee, residualArgs));
            addLeadingComment(residual, `${TODO_PREFIX}: ${message}`);
            this.ctx.report.todo(this.unit.file.path, message, this.line(call.node));
            members.push(residual);
            if (site.importLocal && t.isIdentifier(residualCallee)) this.addLeftover(site.importLocal, residualCallee);
        }

        const parent = call.parentPath;
        if (parent.isSpreadElement() && parent.parentPath.isObjectExpression()) {
            const object = parent.parentPath.node;
            const index = object.properties.indexOf(parent.node);
            const [firstMember] = members;
            if (firstMember) moveComments(parent.node, firstMember);
            object.properties.splice(index, 1, ...members);
        } else {
            const [only] = members;
            if (members.length === 1 && t.isSpreadElement(only)) call.replaceWith(only.argument);
            else call.replaceWith(t.objectExpression(members));
        }

        return leftover.length === 0;
    }

    private extractEntries(mapArg: NodePath): Entry[] | null {
        const entries: Entry[] = [];

        if (mapArg.isArrayExpression()) {
            for (const element of mapArg.get('elements') as NodePath[]) {
                const name = element.node ? resolveString(element, this.unit, this.ctx) : null;
                if (name === null) return null;
                entries.push({ alias: name, name });
            }
            return entries;
        }

        if (!mapArg.isObjectExpression()) return null;

        for (const property of mapArg.get('properties')) {
            if (property.isObjectMethod()) {
                const alias = staticKeyName(property.node.key, property.node.computed);
                if (alias === null) return null;
                entries.push({ alias, fnPath: property });
                continue;
            }
            if (!property.isObjectProperty()) return null;

            const alias = staticKeyName(property.node.key, property.node.computed);
            if (alias === null) return null;

            const value = unwrapPath(property.get('value') as NodePath);
            if (isFunctionNode(value.node)) {
                entries.push({ alias, fnPath: value as NodePath<t.Function> });
                continue;
            }
            const name = resolveString(value, this.unit, this.ctx);
            if (name === null) return null;
            entries.push({ alias, name });
        }

        return entries;
    }

    private residualMapping(mapArg: NodePath, leftover: Entry[]): t.Expression {
        const aliases = new Set(leftover.map((e) => e.alias));
        if (mapArg.isArrayExpression()) {
            return t.arrayExpression(leftover.map((e) => t.stringLiteral(e.name ?? e.alias)));
        }
        const object = mapArg.node as t.ObjectExpression;
        return t.objectExpression(
            object.properties.filter((p) => !t.isSpreadElement(p) && aliases.has(staticKeyName(p.key, p.computed) ?? '')),
        );
    }

    /** `state => state.total` can stay inside Pinia's mapState when it only touches the store's own state. */
    private readsOnlyOwnState(fnPath: NodePath<t.Function>, base: ModuleInfo): boolean {
        if (!base.hasStore) return false;
        const params = fnPath.node.params;
        if (params.length === 0) return true;
        if (params.length > 1) return false;

        const [param] = params;
        if (!t.isIdentifier(param)) return false;

        const binding = fnPath.scope.getBinding(param.name);
        if (!binding) return false;

        return binding.referencePaths.every((reference) => {
            const member = reference.parentPath;
            if (!member?.isMemberExpression() || member.node.object !== reference.node) return false;
            const key = staticKeyName(member.node.property, member.node.computed);
            return key !== null && !base.children.has(key);
        });
    }

    /** `total: state => state.cart.total + state.user.bonus` -> `total() { return useCartStore().total + useUserStore().bonus; }`. */
    private toPlainMethod(entry: Entry, base: ModuleInfo, namespace: string): t.ObjectMethod {
        const fnPath: NodePath<t.Function> = entry.fnPath!;
        if (fnPath.isArrowFunctionExpression()) fnPath.ensureBlock();
        const fn = fnPath.node;
        const body = fn.body as t.BlockStatement;

        const refs = this.ctx.refs(this.unit);
        const rewriter = new Rewriter(this.ctx, this.unit, placeInFunction(refs, fnPath));
        const [state, getters] = fnPath.get('params') as NodePath[];

        if (state?.isIdentifier()) rewriter.rewriteBinding(fnPath, state.node.name, { kind: 'state', module: base });
        else if (state?.isObjectPattern()) rewriter.bindNestedPattern(state, { kind: 'state', module: base });

        if (getters?.isIdentifier()) rewriter.rewriteBinding(fnPath, getters.node.name, { kind: 'getters', namespace });
        else if (getters?.isObjectPattern()) rewriter.bindNestedPattern(getters, { kind: 'getters', namespace });

        rewriter.flush();
        rewriter.emitResiduals(body, fnPath.get('body') as NodePath);

        if (t.isObjectMethod(fn)) {
            fn.params = [];
            return fn;
        }

        const method = t.objectMethod('method', objectKey(entry.alias), [], body, false, false, fn.async);
        const property = fnPath.parentPath.node;
        if (t.isObjectProperty(property)) moveComments(property, method);
        return method;
    }


    private fixImports(vuexImports: t.ImportDeclaration[]): void {
        const body = this.unit.ast.program.body;

        for (const declaration of vuexImports) {
            const kept: t.ImportDeclaration['specifiers'] = [];
            for (const specifier of declaration.specifiers) {
                if (!t.isImportSpecifier(specifier) || !isHelper(importedName(specifier))) {
                    kept.push(specifier);
                    continue;
                }

                const local = specifier.local.name;
                const remaining = this.leftovers.get(local) ?? [];
                if (remaining.length === 0) continue;

                if (this.neededPinia.has(local as PiniaHelper)) {
                    const alias = `vuex${capitalize(local)}`;
                    for (const identifier of remaining) identifier.name = alias;
                    kept.push(t.importSpecifier(t.identifier(alias), t.identifier(importedName(specifier))));
                } else {
                    kept.push(specifier);
                }
            }
            declaration.specifiers = kept;

            if (declaration.specifiers.length === 0) {
                const index = body.indexOf(declaration);
                const next = body[index + 1];
                if (index === 0 && next) moveComments(declaration, next);
                if (index !== -1) body.splice(index, 1);
            }
        }

        for (const helper of this.neededPinia) ensureNamedImport(this.unit, 'pinia', helper);
    }
}
