import { TODO_PREFIX, addLeadingComment, compactPattern, lineOf, moveComments, objectKey, t, unwrapNode, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import { ensureNamedImport, removeStatement } from '../../core/imports.js';
import type { ScriptUnit } from '../../core/project.js';
import type { MemberInfo, MemberKind, ModuleInfo, PartInfo } from '../../core/store-model.js';
import { placeInFunction } from '../shared/placement.js';
import { Rewriter } from '../shared/rewriter.js';

const MEMBER_KINDS: MemberKind[] = ['getters', 'mutations', 'actions'];

interface ConvertedMember {
    module: ModuleInfo;
    member: MemberInfo;
    rewriter: Rewriter;
    leftoverContext?: t.ObjectPattern;
}

export function convertStoreModules(ctx: MigrationContext): void {
    const converter = new ModuleConverter(ctx);
    const modules = ctx.model.storeModules();

    for (const module of ctx.model.modules) {
        if (module.def && !module.hasStore && !module.isRoot) {
            ctx.report.info(
                module.def.unit.file.path,
                `module "${module.pathSegments.join('/')}" only groups other modules — no Pinia store was generated for it, its definition can be deleted`,
            );
        }
    }


    for (const module of modules) converter.rewriteMembers(module);
    converter.restructureMembers();
    for (const module of modules) converter.emit(module);
}

class ModuleConverter {
    private converted: ConvertedMember[] = [];
    private seenFunctions = new Map<t.Node, ModuleInfo>();

    constructor(private ctx: MigrationContext) {}


    rewriteMembers(module: ModuleInfo): void {
        for (const kind of MEMBER_KINDS) {
            for (const member of module.parts[kind]?.members ?? []) {
                if (!member.fnPath || member.dropped) continue;

                const owner = this.seenFunctions.get(member.fnPath.node);
                if (owner) {
                    if (owner !== module) {
                        this.ctx.report.warn(
                            member.unit.file.path,
                            `${kind.slice(0, -1)} "${member.name}" is shared by several modules — it was converted for store "${owner.storeId}" only, review its use in "${module.storeId}"`,
                            lineOf(member.fnPath.node),
                        );
                    }
                    continue;
                }
                this.seenFunctions.set(member.fnPath.node, module);

                this.converted.push(this.rewriteMember(module, member));
            }
        }
    }

    private rewriteMember(module: ModuleInfo, member: MemberInfo): ConvertedMember {
        const fnPath = member.fnPath!;
        const refs = this.ctx.refs(member.unit);
        const rewriter = new Rewriter(this.ctx, member.unit, placeInFunction(refs, fnPath), {
            self: module,
            selfFn: fnPath,
            keepOwnState: member.kind === 'getters',
        });
        const result: ConvertedMember = { module, member, rewriter };
        const params = fnPath.get('params') as NodePath[];

        // In Vuex `this` inside mutations and actions is the store instance.
        const thisPaths = member.kind === 'getters' ? [] : collectThis(fnPath);

        if (member.kind === 'getters') {
            if (needsBlock(fnPath, params)) ensureBlock(fnPath, false);
            this.rewriteGetterParams(module, rewriter, fnPath, params);
        } else {
            ensureBlock(fnPath, member.kind === 'mutations');
            const [first] = params;

            if (member.kind === 'mutations') {
                if (first?.isIdentifier()) rewriter.rewriteBinding(fnPath, first.node.name, { kind: 'state', module });
                else if (first?.isObjectPattern()) rewriter.bindNestedPattern(first, { kind: 'state', module });
                else if (first) rewriter.todo(first, 'unsupported state parameter — migrate this mutation manually');
            } else {
                if (first?.isIdentifier()) rewriter.rewriteBinding(fnPath, first.node.name, { kind: 'context', module });
                else if (first?.isObjectPattern()) {
                    if (!rewriter.bindPattern(first, (key) => rewriter.contextRole(key, module))) result.leftoverContext = first.node;
                } else if (first) rewriter.todo(first, 'unsupported context parameter — migrate this action manually');
            }
        }

        for (const thisPath of thisPaths) {
            if (!rewriter.rewriteStore(thisPath, true)) {
                rewriter.todo(thisPath, 'in Vuex `this` was the store instance here; in Pinia `this` is this store — review this access');
            }
        }

        rewriter.flush();
        return result;
    }

    private rewriteGetterParams(module: ModuleInfo, rewriter: Rewriter, fnPath: NodePath<t.Function>, params: NodePath[]): void {
        const [state, getters, rootState, rootGetters] = params;
        const root = this.ctx.model.root;

        if (state?.isIdentifier()) {
            rewriter.rewriteBinding(fnPath, state.node.name, { kind: 'state', module });
        } else if (state?.isObjectPattern()) {
            for (const property of state.node.properties) {
                if (t.isObjectProperty(property) && t.isIdentifier(property.key) && module.children.has(property.key.name)) {
                    rewriter.todo(state, `"${property.key.name}" is a nested module — its state is no longer part of this store's state`);
                }
            }
        }

        if (getters?.isIdentifier()) rewriter.rewriteBinding(fnPath, getters.node.name, { kind: 'getters', namespace: module.namespace });
        else if (getters?.isObjectPattern()) rewriter.bindNestedPattern(getters, { kind: 'getters', namespace: module.namespace });

        if (rootState?.isIdentifier()) rewriter.rewriteBinding(fnPath, rootState.node.name, { kind: 'state', module: root });
        else if (rootState?.isObjectPattern()) rewriter.bindNestedPattern(rootState, { kind: 'state', module: root });

        if (rootGetters?.isIdentifier()) rewriter.rewriteBinding(fnPath, rootGetters.node.name, { kind: 'getters', namespace: '' });
        else if (rootGetters?.isObjectPattern()) rewriter.bindNestedPattern(rootGetters, { kind: 'getters', namespace: '' });
    }


    restructureMembers(): void {
        for (const { module, member, rewriter, leftoverContext } of this.converted) {
            const fnPath = member.fnPath!;
            const fn = fnPath.node;

            if (rewriter.residuals.size > 0 && t.isBlockStatement(fn.body)) {
                rewriter.emitResiduals(fn.body, fnPath.get('body') as NodePath);
            }

            if (member.kind === 'getters') {
                fn.params.length = Math.min(fn.params.length, 1);
            } else {
                fn.params.shift();
            }

            if (leftoverContext && t.isBlockStatement(fn.body)) {
                delete (leftoverContext as { typeAnnotation?: unknown }).typeAnnotation;
                const declaration = t.variableDeclaration('const', [t.variableDeclarator(compactPattern(leftoverContext), t.thisExpression())]);
                addLeadingComment(declaration, `${TODO_PREFIX}: these were taken from the Vuex action context and have no Pinia equivalent`);
                fn.body.body.unshift(declaration);
            }

            const needsThis = member.kind !== 'getters' || rewriter.usedThis;
            if (needsThis && t.isArrowFunctionExpression(fn)) convertArrow(fnPath as NodePath<t.ArrowFunctionExpression>);

            if (member.kind === 'getters' && rewriter.usedThis && member.unit.lang !== 'js' && member.unit.lang !== 'jsx' && !fn.returnType) {
                this.ctx.report.info(
                    member.unit.file.path,
                    `getter "${member.finalName}" of store "${module.storeId}" reads other getters through \`this\` — add an explicit return type so TypeScript can infer the store type`,
                    lineOf(fn),
                );
            }
        }

        for (const module of this.ctx.model.storeModules()) {
            for (const kind of MEMBER_KINDS) {
                const part = module.parts[kind];
                if (!part?.objectPath) continue;
                const object = part.objectPath.node;

                for (const member of part.members) {
                    if (!member.renamable) continue;
                    const holder = member.holderPath.node;
                    if (member.dropped) {
                        object.properties = object.properties.filter((p) => p !== holder);
                        continue;
                    }
                    if (member.finalName === null || member.finalName === member.name) continue;

                    const current = object.properties.find(
                        (p): p is t.ObjectProperty | t.ObjectMethod =>
                            !t.isSpreadElement(p) && (p === holder || (!p.computed && keyOf(p) === member.name)),
                    );
                    if (!current) continue;
                    current.key = objectKey(member.finalName);
                    current.computed = false;
                    if (t.isObjectProperty(current)) current.shorthand = false;
                }
            }
        }
    }


    emit(module: ModuleInfo): void {
        const def = module.def!;
        const unit = def.unit;
        const body = unit.ast.program.body;

        const options = t.objectExpression([]);
        const state = this.stateProperty(module);
        if (state) options.properties.push(state);
        const getters = this.gettersProperty(module);
        if (getters) options.properties.push(getters);
        const actions = this.actionsProperty(module);
        if (actions) options.properties.push(actions);

        const statement = t.exportNamedDeclaration(
            t.variableDeclaration('const', [
                t.variableDeclarator(
                    t.identifier(module.exportName),
                    t.callExpression(t.identifier('defineStore'), [t.stringLiteral(module.storeId), options]),
                ),
            ]),
        );

        const current = (node: t.Node): t.Node => {
            let result = node;
            while (unit.replaced.has(result)) result = unit.replaced.get(result)!;
            return result;
        };

        const replace = (old: t.Statement): void => {
            const index = body.indexOf(current(old) as t.Statement);
            if (index === -1) {
                body.push(statement);
                return;
            }
            moveComments(body[index]!, statement);
            unit.replaced.set(old, statement);
            body[index] = statement;
        };

        if (def.kind === 'named-exports' || !def.objectPath) {
            body.push(statement);
        } else {
            let holder: NodePath = def.objectPath;
            while (holder.parentPath && unwrapNode(holder.parentPath.node) !== holder.parentPath.node) holder = holder.parentPath;
            const parent = holder.parentPath!;

            if (def.kind === 'export-default') {
                replace(parent.node as t.Statement);
            } else if (def.kind === 'variable') {
                const declaration = parent.parentPath!;
                const localName = ((parent.node as t.VariableDeclarator).id as t.Identifier).name;
                const outer = declaration.parentPath!.isExportNamedDeclaration() ? declaration.parentPath! : declaration;
                replace(outer.node as t.Statement);
                removeExportsOf(body, localName);
            } else {
                const top = def.objectPath.findParent((p) => !!p.parentPath?.isProgram());
                const index = top ? body.indexOf(current(top.node) as t.Statement) : -1;
                if (index === -1) body.push(statement);
                else {
                    if (index === 0) moveComments(body[0]!, statement);
                    body.splice(index, 0, statement);
                }
            }
        }

        ensureNamedImport(unit, 'pinia', 'defineStore');
    }

    private removeDeclaration(declarator: NodePath<t.VariableDeclarator>, unit: ScriptUnit, commentsTo?: t.Node): void {
        const declaration = declarator.parent as t.VariableDeclaration;
        if (commentsTo) moveComments(declaration, commentsTo);
        removeStatement(unit.ast.program.body, declaration);
    }

    private stateProperty(module: ModuleInfo): t.ObjectProperty | t.ObjectMethod | null {
        const part = module.parts.state;
        if (!part) return null;
        const unit = module.def!.unit;
        const existing = part.propPath?.node;
        const key = t.identifier('state');

        const withValue = (value: t.Expression): t.ObjectProperty => {
            if (existing && t.isObjectProperty(existing)) {
                existing.value = value;
                existing.shorthand = false;
                return existing;
            }
            return t.objectProperty(key, value);
        };
        const reference = (): t.Expression =>
            existing && t.isObjectProperty(existing) ? (existing.value as t.Expression) : t.identifier(part.ident ?? 'state');

        if (part.form === 'function') return existing ?? null;

        if (part.form === 'inline-object') {
            return withValue(t.arrowFunctionExpression([], (existing as t.ObjectProperty).value as t.Expression));
        }

        if (part.inlineDeclarator) {
            const declarator = part.inlineDeclarator.node;
            const init = declarator.init!;
            let value: t.Expression = init;
            if (part.form !== 'ident-function') {
                const arrow = t.arrowFunctionExpression([], init);
                const annotation = (declarator.id as t.Identifier).typeAnnotation;
                if (t.isTSTypeAnnotation(annotation)) arrow.returnType = annotation;
                value = arrow;
            }
            const property = withValue(value);
            this.removeDeclaration(part.inlineDeclarator, unit, property);
            return property;
        }

        if (part.form === 'ident-function') {
            return existing ?? t.objectProperty(key, t.identifier(part.ident ?? 'state'), false, part.ident === 'state');
        }

        if (part.form === 'ident-object') {
            return withValue(t.arrowFunctionExpression([], t.objectExpression([t.spreadElement(reference())])));
        }

        const value = reference();
        if (t.isCallExpression(unwrapNode(value))) return withValue(t.arrowFunctionExpression([], value));

        this.ctx.report.warn(
            unit.file.path,
            `store "${module.storeId}": the state definition could not be analysed — make sure "state" is a function returning the initial state`,
            lineOf(existing),
        );
        return existing ?? null;
    }

    private gettersProperty(module: ModuleInfo): t.ObjectProperty | t.ObjectMethod | null {
        const part = module.parts.getters;
        if (!part) return null;
        const existing = part.propPath?.node;
        const key = t.identifier('getters');

        if (part.form === 'inline-object') {
            return part.objectPath!.node.properties.length > 0 ? (existing ?? null) : null;
        }

        if (part.form === 'ident-object' && part.inlineDeclarator && existing && t.isObjectProperty(existing)) {
            const object = part.objectPath!.node;
            this.removeDeclaration(part.inlineDeclarator, module.def!.unit, existing);
            if (object.properties.length === 0) return null;
            existing.value = object;
            existing.shorthand = false;
            return existing;
        }

        if (part.form === 'ident-object') stripTyping(part);

        if (part.form === 'namespace') {
            return t.objectProperty(key, t.objectExpression([t.spreadElement(t.identifier(part.ident!))]));
        }

        return existing ?? t.objectProperty(key, t.identifier(part.ident ?? 'getters'), false, part.ident === 'getters');
    }

    private actionsProperty(module: ModuleInfo): t.ObjectProperty | null {
        const elements: t.ObjectExpression['properties'] = [];
        const unit = module.def!.unit;

        for (const kind of ['mutations', 'actions'] as const) {
            const part = module.parts[kind];
            if (!part) continue;

            if (part.form === 'inline-object') {
                elements.push(...part.objectPath!.node.properties);
            } else if (part.form === 'ident-object' && part.inlineDeclarator) {
                elements.push(...part.objectPath!.node.properties);
                this.removeDeclaration(part.inlineDeclarator, unit);
            } else {
                if (part.form === 'ident-object') stripTyping(part);
                const existing = part.propPath?.node;
                const reference =
                    existing && t.isObjectProperty(existing) ? (existing.value as t.Expression) : t.identifier(part.ident ?? kind);
                elements.push(t.spreadElement(reference));
            }
        }

        if (elements.length === 0) return null;

        const base = module.parts.actions ?? module.parts.mutations!;
        const existing = base.propPath?.node;

        if (base.form === 'inline-object' && existing && t.isObjectProperty(existing)) {
            base.objectPath!.node.properties = elements;
            existing.key = t.identifier('actions');
            existing.computed = false;
            return existing;
        }

        const property = t.objectProperty(t.identifier('actions'), t.objectExpression(elements));
        if (existing) moveComments(existing, property);
        return property;
    }
}

function keyOf(property: t.ObjectProperty | t.ObjectMethod): string | null {
    if (t.isIdentifier(property.key)) return property.key.name;
    if (t.isStringLiteral(property.key)) return property.key.value;
    return null;
}

/** `const getters: GetterTree<S, R> = {...}` / `{...} as GetterTree<S, R>` — the Vuex types no longer apply. */
function stripTyping(part: PartInfo): void {
    if (!part.objectPath) return;

    let holder: NodePath = part.objectPath;
    while (holder.parentPath && unwrapNode(holder.parentPath.node) !== holder.parentPath.node) holder = holder.parentPath;

    if (holder !== part.objectPath) {
        const container = holder.container as unknown as Record<string | number, unknown>;
        if (container[holder.key as string | number] === holder.node) container[holder.key as string | number] = part.objectPath.node;
    }

    const parent = holder.parentPath;
    if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) parent.node.id.typeAnnotation = null;
}

function removeExportsOf(body: t.Statement[], localName: string): void {
    for (const statement of [...body]) {
        if (t.isExportDefaultDeclaration(statement) && t.isIdentifier(unwrapNode(statement.declaration), { name: localName })) {
            removeStatement(body, statement);
        } else if (t.isExportNamedDeclaration(statement) && !statement.source && !statement.declaration) {
            const before = statement.specifiers.length;
            statement.specifiers = statement.specifiers.filter((s) => !t.isExportSpecifier(s) || s.local.name !== localName);
            if (before > 0 && statement.specifiers.length === 0) removeStatement(body, statement);
        }
    }
}

function collectThis(fnPath: NodePath<t.Function>): NodePath[] {
    if (fnPath.isArrowFunctionExpression()) return [];
    const found: NodePath[] = [];
    fnPath.traverse({
        ThisExpression(path) {
            found.push(path);
        },
        Function(path) {
            if (!path.isArrowFunctionExpression()) path.skip();
        },
        Class(path) {
            path.skip();
        },
    });
    return found;
}

function needsBlock(fnPath: NodePath<t.Function>, params: NodePath[]): boolean {
    if (!fnPath.isArrowFunctionExpression() || t.isBlockStatement(fnPath.node.body)) return false;
    return params.slice(1).some((param) => {
        if (param.isObjectPattern()) return true;
        if (!param.isIdentifier()) return false;
        const binding = fnPath.scope.getBinding(param.node.name);
        return (binding?.referencePaths.length ?? 0) > 1;
    });
}

function ensureBlock(fnPath: NodePath<t.Function>, dropReturn: boolean): void {
    if (!fnPath.isArrowFunctionExpression() || t.isBlockStatement(fnPath.node.body)) return;

    fnPath.ensureBlock();
    if (!dropReturn) return;

    // mutations return nothing: `(state, v) => (state.a = v)` becomes `{ this.a = v; }`
    const [statement] = (fnPath.node.body as t.BlockStatement).body;
    if (t.isReturnStatement(statement) && statement.argument) {
        const node = statement as unknown as Record<string, unknown>;
        node.type = 'ExpressionStatement';
        node.expression = statement.argument;
        const extra = (statement.argument as { extra?: Record<string, unknown> }).extra;
        if (extra) delete extra.parenthesized;
        delete node.argument;
    }
}

function convertArrow(fnPath: NodePath<t.ArrowFunctionExpression>): void {
    const arrow = fnPath.node;
    if (!t.isBlockStatement(arrow.body)) {
        arrow.body = t.blockStatement([t.returnStatement(arrow.body)]);
    }
    const body = arrow.body;
    const parent = fnPath.parentPath;

    if (parent.isObjectProperty() && parent.node.value === arrow && parent.parentPath.isObjectExpression()) {
        const property = parent.node;
        const method = t.objectMethod('method', property.key as t.Expression, arrow.params, body, property.computed, false, arrow.async);
        method.returnType = arrow.returnType;
        method.typeParameters = arrow.typeParameters as t.ObjectMethod['typeParameters'];
        moveComments(property, method);

        const object = parent.parentPath.node;
        const index = object.properties.indexOf(property);
        if (index !== -1) {
            object.properties[index] = method;
            return;
        }
    }

    const fn = t.functionExpression(null, arrow.params, body, false, arrow.async);
    fn.returnType = arrow.returnType;
    fn.typeParameters = arrow.typeParameters as t.FunctionExpression['typeParameters'];

    const container = fnPath.container as unknown as Record<string | number, unknown>;
    const key = fnPath.key as string | number;
    if (container[key] === arrow) container[key] = fn;
}
