import {
    TODO_PREFIX,
    addLeadingComment,
    commentAnchor,
    compactPattern,
    isCallLike,
    isMemberLike,
    lineOf,
    memberAccess,
    objectKey,
    staticKeyName,
    t,
    unwrapPath,
    type NodePath,
} from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import type { ScriptUnit } from '../../core/project.js';
import { resolveString } from '../../core/resolve.js';
import type { MemberKind, MemberTarget, ModuleInfo } from '../../core/store-model.js';

export type Placer = (module: ModuleInfo, at: NodePath) => t.Expression;

export type Role =
    | { kind: 'store' }
    | { kind: 'context'; module: ModuleInfo }
    | { kind: 'state'; module: ModuleInfo }
    | { kind: 'getters'; namespace: string }
    | { kind: 'commit'; namespace: string }
    | { kind: 'dispatch'; namespace: string };

export interface RewriterOptions {
    self?: ModuleInfo;
    selfFn?: NodePath<t.Function>;
    keepOwnState?: boolean;
    noComments?: boolean;
    fixedLine?: number;
}

const STORE_API_HINTS: Record<string, string> = {
    subscribe: 'store.subscribe() has no global equivalent — use `someStore.$subscribe()` on the specific Pinia store',
    subscribeAction: 'store.subscribeAction() has no global equivalent — use `someStore.$onAction()` on the specific Pinia store',
    watch: 'store.watch() does not exist in Pinia — use `watch()` from vue with a store getter',
    replaceState: 'store.replaceState() does not exist in Pinia — assign `pinia.state.value` or use `someStore.$patch()`',
    registerModule: 'store.registerModule() is not needed in Pinia — stores are registered when `useXStore()` is first called',
    unregisterModule: 'store.unregisterModule() does not exist in Pinia — call `someStore.$dispose()` instead',
    hasModule: 'store.hasModule() does not exist in Pinia — stores are created lazily on first use',
    hotUpdate: 'store.hotUpdate() does not exist in Pinia — use `acceptHMRUpdate()`',
};

const THENABLE_METHODS = new Set(['then', 'catch', 'finally']);

function memberParentOf(path: NodePath): NodePath<t.MemberExpression | t.OptionalMemberExpression> | null {
    const parent = path.parentPath;
    if (parent && isMemberLike(parent.node) && parent.node.object === path.node) {
        return parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>;
    }
    return null;
}


export class Rewriter {
    usedThis = false;
    residuals = new Map<ModuleInfo, t.ObjectProperty[]>();
    private deferred: (() => void)[] = [];

    constructor(
        public ctx: MigrationContext,
        public unit: ScriptUnit,
        public place: Placer,
        public options: RewriterOptions = {},
    ) {}


    storeExpr(module: ModuleInfo, at: NodePath): t.Expression {
        const { self, selfFn } = this.options;
        if (self === module && selfFn && this.thisIsStore(at, selfFn)) {
            this.usedThis = true;
            return t.thisExpression();
        }
        return this.place(module, at);
    }

    private thisIsStore(at: NodePath, selfFn: NodePath<t.Function>): boolean {
        for (let current: NodePath | null = at; current; current = current.parentPath) {
            if (current.node === selfFn.node) return true;
            if (current.isFunction() && !current.isArrowFunctionExpression()) return false;
            if (current.isClass()) return false;
        }
        return true;
    }

    todo(path: NodePath, message: string): void {
        if (!this.options.noComments) addLeadingComment(commentAnchor(path), `${TODO_PREFIX}: ${message}`);
        this.ctx.report.todo(this.unit.file.path, message, this.line(path));
    }

    warn(path: NodePath, message: string): void {
        this.ctx.report.warn(this.unit.file.path, message, this.line(path));
    }

    private line(path: NodePath): number | undefined {
        if (this.options.fixedLine !== undefined) return this.options.fixedLine;
        if (this.options.noComments) return undefined;
        const line = lineOf(path.node) ?? lineOf(path.find((p) => !!p.node.loc)?.node);
        if (line === undefined) return undefined;
        // SFC blocks are parsed on their own: shift by the lines preceding the block
        if (this.unit.start === 0) return line;
        return line + this.unit.file.source.slice(0, this.unit.start).split('\n').length - 1;
    }

    private describe(module: ModuleInfo): string {
        return module.isRoot ? 'the root store' : `module "${module.pathSegments.join('/')}"`;
    }

    flush(): void {
        const pending = this.deferred;
        this.deferred = [];
        for (const run of pending) run();
    }


    rewriteRole(path: NodePath, role: Role): boolean {
        switch (role.kind) {
            case 'store':
                return this.rewriteStore(path);
            case 'context':
                return this.rewriteContext(path, role.module);
            case 'state':
                return this.rewriteState(path, role.module);
            case 'getters':
                return this.rewriteGetters(path, role.namespace);
            case 'commit':
                return this.rewriteCall(path, 'mutations', role.namespace);
            case 'dispatch':
                return this.rewriteCall(path, 'actions', role.namespace);
        }
    }

    rewriteBinding(scopePath: NodePath, name: string, role: Role): boolean {
        const binding = scopePath.scope.getBinding(name);
        if (!binding) return true;

        let ok = true;
        for (const reference of binding.referencePaths) {
            if (!reference.isIdentifier()) continue;
            if (!this.rewriteRole(reference, role)) ok = false;
        }
        for (const violation of binding.constantViolations) {
            if (violation.isAssignmentExpression() || violation.isUpdateExpression()) {
                this.todo(violation, `"${name}" is reassigned here — review this code after the migration`);
                ok = false;
            }
        }
        return ok;
    }


    rewriteStore(path: NodePath, silent = false): boolean {
        const parent = memberParentOf(path);

        if (parent) {
            const key = staticKeyName(parent.node.property, parent.node.computed);
            switch (key) {
                case 'state':
                    return this.rewriteState(parent, this.ctx.model.root);
                case 'getters':
                    return this.rewriteGetters(parent, '');
                case 'commit':
                    return this.rewriteCall(parent, 'mutations', '');
                case 'dispatch':
                    return this.rewriteCall(parent, 'actions', '');
            }
            if (!silent) {
                this.todo(path, (key && STORE_API_HINTS[key]) ?? `"${key ?? 'this property'}" of the Vuex store has no direct Pinia equivalent — migrate manually`);
            }
            return false;
        }

        const declarator = path.parentPath;
        if (declarator?.isVariableDeclarator() && declarator.node.init === path.node && declarator.get('id').isObjectPattern()) {
            const pattern = declarator.get('id') as NodePath<t.ObjectPattern>;
            const ok = this.bindPattern(pattern, (key) => this.storeRole(key));
            if (ok) {
                const declaration = declarator.parentPath;
                if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 1) declaration.remove();
                else declarator.remove();
            }
            return ok;
        }

        if (!silent) this.todo(path, 'the Vuex store instance is used directly here — replace it with the Pinia store(s) you need');
        return false;
    }

    private storeRole(key: string): Role | null {
        switch (key) {
            case 'state':
                return { kind: 'state', module: this.ctx.model.root };
            case 'getters':
                return { kind: 'getters', namespace: '' };
            case 'commit':
                return { kind: 'commit', namespace: '' };
            case 'dispatch':
                return { kind: 'dispatch', namespace: '' };
            default:
                return null;
        }
    }


    contextRole(key: string, module: ModuleInfo): Role | null {
        switch (key) {
            case 'state':
                return { kind: 'state', module };
            case 'getters':
                return { kind: 'getters', namespace: module.namespace };
            case 'commit':
                return { kind: 'commit', namespace: module.namespace };
            case 'dispatch':
                return { kind: 'dispatch', namespace: module.namespace };
            case 'rootState':
                return { kind: 'state', module: this.ctx.model.root };
            case 'rootGetters':
                return { kind: 'getters', namespace: '' };
            default:
                return null;
        }
    }

    rewriteContext(path: NodePath, module: ModuleInfo): boolean {
        const parent = memberParentOf(path);
        if (!parent) {
            this.todo(path, 'the Vuex action context is passed around as a value — pass the Pinia store (or `this`) instead');
            return false;
        }

        const key = staticKeyName(parent.node.property, parent.node.computed);
        const role = key === null ? null : this.contextRole(key, module);
        if (!role) {
            this.todo(path, `"${key ?? 'dynamic property'}" of the Vuex action context has no Pinia equivalent — migrate manually`);
            return false;
        }
        return this.rewriteRole(parent, role);
    }

    bindPattern(pattern: NodePath<t.ObjectPattern>, roleFor: (key: string) => Role | null): boolean {
        const converted = new Set<t.Node>();

        for (const property of pattern.get('properties')) {
            if (!property.isObjectProperty()) {
                this.todo(property, 'rest element in a Vuex store/context destructuring — migrate manually');
                continue;
            }

            const key = staticKeyName(property.node.key, property.node.computed);
            const role = key === null ? null : roleFor(key);
            if (!role) {
                this.todo(property, `"${key ?? 'computed key'}" cannot be taken from a Pinia store this way — migrate manually`);
                continue;
            }

            let value = property.get('value') as NodePath;
            if (value.isAssignmentPattern()) value = value.get('left') as NodePath;

            if (value.isIdentifier()) {
                if (this.rewriteBinding(pattern, value.node.name, role)) converted.add(property.node);
            } else if (value.isObjectPattern() && this.bindNestedPattern(value, role)) {
                converted.add(property.node);
            } else if (!value.isObjectPattern()) {
                this.todo(property, 'unsupported destructuring of the Vuex store/context — migrate manually');
            }
        }

        pattern.node.properties = pattern.node.properties.filter((p) => !converted.has(p));
        return pattern.node.properties.length === 0;
    }

    /** `{ state: { total } }` / `{ rootState: { cart } }` / `{ getters: { isEmpty } }`. */
    bindNestedPattern(pattern: NodePath<t.ObjectPattern>, role: Role): boolean {
        if (role.kind !== 'state' && role.kind !== 'getters') {
            this.todo(pattern, 'unsupported nested destructuring — migrate manually');
            return false;
        }

        let ok = true;
        for (const property of pattern.get('properties')) {
            if (!property.isObjectProperty()) {
                this.todo(property, 'rest element in a Vuex state/getters destructuring — migrate manually');
                ok = false;
                continue;
            }

            const key = staticKeyName(property.node.key, property.node.computed);
            if (key === null) {
                this.todo(property, 'computed key in a Vuex state/getters destructuring — migrate manually');
                ok = false;
                continue;
            }

            let value = property.get('value') as NodePath;
            const valueNode = property.node.value;
            if (value.isAssignmentPattern()) value = value.get('left') as NodePath;

            if (role.kind === 'state') {
                const child = role.module.children.get(key);
                if (child) {
                    const childRole: Role = { kind: 'state', module: child };
                    if (value.isIdentifier()) ok = this.rewriteBinding(pattern, value.node.name, childRole) && ok;
                    else if (value.isObjectPattern()) ok = this.bindNestedPattern(value, childRole) && ok;
                    else ok = false;
                    continue;
                }
                if (!role.module.hasStore) {
                    this.todo(property, `${this.describe(role.module)} has no Pinia store — migrate this access manually`);
                    ok = false;
                    continue;
                }
                this.addResidual(role.module, t.objectProperty(objectKey(key), valueNode as t.PatternLike, false, isShorthand(key, valueNode)));
            } else {
                const target = this.findTarget('getters', role.namespace + key, property);
                if (!target) {
                    this.todo(property, `getter "${role.namespace}${key}" was not found in the store`);
                    ok = false;
                    continue;
                }
                this.addResidual(target.module, t.objectProperty(objectKey(target.name), valueNode as t.PatternLike, false, isShorthand(target.name, valueNode)));
            }
        }
        return ok;
    }

    private addResidual(module: ModuleInfo, property: t.ObjectProperty): void {
        const list = this.residuals.get(module) ?? [];
        list.push(property);
        this.residuals.set(module, list);
    }

    emitResiduals(block: t.BlockStatement, at: NodePath): void {
        const declarations: t.VariableDeclaration[] = [];
        for (const [module, properties] of this.residuals) {
            declarations.push(
                t.variableDeclaration('const', [t.variableDeclarator(compactPattern(t.objectPattern(properties)), this.storeExpr(module, at))]),
            );
        }
        this.residuals.clear();
        block.body.unshift(...declarations);
    }

    rewriteState(path: NodePath, base: ModuleInfo): boolean {
        const chain: { name: string; path: NodePath }[] = [];
        for (let current: NodePath = path; ; ) {
            const parent = memberParentOf(current);
            if (!parent) break;
            const name = staticKeyName(parent.node.property, parent.node.computed);
            if (name === null) break;
            chain.push({ name, path: parent });
            current = parent;
        }

        let module = base;
        let consumed = 0;
        for (; consumed < chain.length; consumed++) {
            const child = module.children.get(chain[consumed]!.name);
            if (!child) break;
            module = child;
        }

        const target = consumed === 0 ? path : chain[consumed - 1]!.path;
        const next = chain[consumed];

        if (!module.hasStore) {
            const reason =
                module.def === null
                    ? `${this.describe(module)} could not be migrated, so this state access was left as is`
                    : `${this.describe(module)} has no state of its own (no Pinia store was generated for it) — review this access`;
            this.todo(path, reason);
            return false;
        }

        if (module === this.options.self && this.options.keepOwnState) return true;

        const store = this.storeExpr(module, path);

        if (next) {
            if (module.stateKeysComplete && !module.stateKeys.has(next.name)) {
                this.warn(path, `"${next.name}" is not a state property declared by ${this.describe(module)} — make sure it exists on the Pinia store`);
            }
            target.replaceWith(store);
            return true;
        }

        const dynamic = memberParentOf(target) !== null;
        target.replaceWith(dynamic ? store : t.memberExpression(store, t.identifier('$state')));
        if (module.children.size > 0) {
            this.warn(path, `the state of ${this.describe(module)} is used as a whole — nested module state is no longer part of it (each module is its own Pinia store)`);
        }
        return true;
    }


    private findTarget(kind: MemberKind, fullName: string, at: NodePath): MemberTarget | null {
        const targets = this.ctx.model.findMembers(kind, fullName);
        const [first] = targets;
        if (!first) return null;
        if (!first.member) {
            this.warn(at, `"${fullName}" is not declared statically — assumed to exist on store "${first.module.storeId}"`);
        }
        return first;
    }

    rewriteGetters(path: NodePath, namespace: string): boolean {
        const { self } = this.options;
        const isOwn = !!self && self.hasStore && namespace === self.namespace;
        const parent = memberParentOf(path);

        if (parent) {
            const name = staticKeyName(parent.node.property, parent.node.computed);
            if (name !== null) {
                const target = this.findTarget('getters', namespace + name, path);
                if (!target) {
                    this.todo(path, `getter "${namespace}${name}" was not found in the store — migrate this access manually`);
                    return false;
                }
                parent.replaceWith(memberAccess(this.storeExpr(target.module, path), target.name));
                return true;
            }

            if (isOwn) {
                this.warn(path, 'dynamic getter access — assumed to be a getter of the same store');
                path.replaceWith(this.storeExpr(self, path));
                return true;
            }
            this.todo(path, 'getter accessed with a dynamic key — read it from the matching Pinia store instead');
            return false;
        }

        if (isOwn) {
            path.replaceWith(this.storeExpr(self, path));
            return true;
        }
        this.todo(path, 'the Vuex getters object is used as a whole — read the getters from the matching Pinia store(s) instead');
        return false;
    }


    rewriteCall(path: NodePath, kind: 'mutations' | 'actions', namespace: string): boolean {
        const verb = kind === 'mutations' ? 'commit' : 'dispatch';
        const noun = kind === 'mutations' ? 'mutation' : 'action';
        const call = path.parentPath as NodePath<t.CallExpression> | null;

        if (!call || !isCallLike(call.node) || call.node.callee !== path.node) {
            this.todo(path, `"${verb}" is used as a value — call the action of the Pinia store directly instead`);
            return false;
        }

        const node = call.node;
        const args = call.get('arguments') as NodePath[];
        const first = args[0];
        if (!first || first.isSpreadElement()) {
            this.todo(call, `${verb}() without a static type could not be migrated — call the store action directly`);
            return false;
        }

        let typePath = first;
        let objectStyle = false;
        const firstValue = unwrapPath(first);
        if (firstValue.isObjectExpression()) {
            const typeProperty = firstValue
                .get('properties')
                .find((p) => p.isObjectProperty() && staticKeyName(p.node.key, p.node.computed) === 'type');
            if (!typeProperty) {
                this.todo(call, `object-style ${verb}() without a "type" property could not be migrated`);
                return false;
            }
            typePath = typeProperty.get('value') as NodePath;
            objectStyle = true;
        }

        const optionsNode = node.arguments[objectStyle ? 1 : 2];
        let root = false;
        if (t.isObjectExpression(optionsNode)) {
            root = optionsNode.properties.some(
                (p) => t.isObjectProperty(p) && staticKeyName(p.key, p.computed) === 'root' && t.isBooleanLiteral(p.value, { value: true }),
            );
        } else if (optionsNode) {
            this.warn(call, `the options argument of ${verb}() could not be analysed — assumed it is not { root: true }`);
        }

        const { self } = this.options;
        const type = resolveString(typePath, this.unit, this.ctx);
        let callee: (store: t.Expression) => t.Expression;
        let targets: MemberTarget[];

        if (type === null) {
            const isOwn = !!self && self.hasStore && !root && !objectStyle && namespace === self.namespace;
            if (!isOwn) {
                this.todo(call, `${verb}() with a dynamic type could not be migrated — call the action of the matching Pinia store directly`);
                return false;
            }
            this.warn(call, `${verb}() with a dynamic type — assumed to target an action of the same store`);
            const typeNode = typePath.node as t.Expression;
            targets = [{ module: self, member: null, name: '' }];
            callee = (store) => t.memberExpression(store, t.cloneNode(typeNode), true);
        } else {
            const fullName = (root ? '' : namespace) + type;
            targets = this.ctx.model.findMembers(kind, fullName);
            const [target] = targets;
            if (!target) {
                this.todo(call, `${noun} "${fullName}" was not found in the store — migrate this ${verb}() manually`);
                return false;
            }
            if (!target.member) {
                this.warn(call, `${noun} "${fullName}" is not declared statically — assumed to exist on store "${target.module.storeId}"`);
            }

            const keepExpression =
                !!target.member?.computed && !objectStyle && !typePath.isStringLiteral() && type === target.member.name && targets.length === 1;
            const typeNode = typePath.node as t.Expression;
            callee = keepExpression
                ? (store) => t.memberExpression(store, t.cloneNode(typeNode), true)
                : (store) => memberAccess(store, target.name);
        }

        const stripArguments = (): void => {
            node.arguments.splice(objectStyle ? 1 : 2);
            if (objectStyle) return;
            node.arguments.shift();
            const [payload] = node.arguments;
            if (optionsNode && (t.isNullLiteral(payload) || t.isIdentifier(payload, { name: 'undefined' }))) node.arguments.length = 0;
        };

        if (targets.length > 1) {
            this.warn(call, `${noun} "${type}" is handled by ${targets.length} non-namespaced modules — every one of them is called now, review the result`);
            this.deferred.push(() => {
                stripArguments();
                const calls = targets.map((target) =>
                    t.callExpression(
                        memberAccess(this.storeExpr(target.module, call), target.name),
                        node.arguments.map((a) => t.cloneNode(a)),
                    ),
                );
                const parent = call.parentPath;
                if (parent.isExpressionStatement()) {
                    parent.replaceWithMultiple(calls.map((c) => t.expressionStatement(c)));
                } else if (kind === 'actions') {
                    call.replaceWith(
                        t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('all')), [t.arrayExpression(calls)]),
                    );
                } else {
                    call.replaceWith(t.sequenceExpression(calls));
                }
            });
            return true;
        }

        const target = targets[0]!;
        stripArguments();
        (call.get('callee') as NodePath).replaceWith(callee(this.storeExpr(target.module, call)));

        const returnsPromise = !!target.member?.isAsync && !target.member.dropped;
        if (kind === 'actions' && !returnsPromise) this.wrapThenable(call);

        return true;
    }

    private wrapThenable(call: NodePath<t.CallExpression>): void {
        const parent = memberParentOf(call);
        if (!parent) return;
        const method = staticKeyName(parent.node.property, parent.node.computed);
        if (method === null || !THENABLE_METHODS.has(method)) return;

        call.replaceWith(t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), [call.node]));
    }
}

function isShorthand(key: string, value: t.Node): boolean {
    if (t.isIdentifier(value)) return value.name === key;
    if (t.isAssignmentPattern(value)) return t.isIdentifier(value.left, { name: key });
    return false;
}
