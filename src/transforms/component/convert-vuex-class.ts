import { TODO_PREFIX, addLeadingComment, isFunctionNode, memberAccess, moveComments, staticKeyName, t, unwrapPath, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import { importedName, importsFrom } from '../../core/imports.js';
import type { ScriptUnit } from '../../core/project.js';
import { resolveString } from '../../core/resolve.js';
import { normalizeNamespace, type MemberKind } from '../../core/store-model.js';
import { Rewriter } from '../shared/rewriter.js';

type BindingKind = 'State' | 'Getter' | 'Action' | 'Mutation';

const KINDS: Record<BindingKind, MemberKind | 'state'> = {
    State: 'state',
    Getter: 'getters',
    Action: 'actions',
    Mutation: 'mutations',
};

function isBindingKind(name: string | null): name is BindingKind {
    return name !== null && name in KINDS;
}

interface DecoratorInfo {
    kind: BindingKind;
    namespace: string;
    argument: NodePath | null;
}


export function convertVuexClass(ctx: MigrationContext, unit: ScriptUnit): void {
    const imports = importsFrom(unit, 'vuex-class');
    if (imports.length === 0) return;

    const scope = unit.program.scope;
    const decorators = new Map<string, BindingKind>(); // local name -> kind
    const namespaces = new Map<string, string>(); // local variable -> namespace
    const namespaceDeclarators: NodePath<t.VariableDeclarator>[] = [];

    for (const declaration of imports) {
        for (const specifier of declaration.specifiers) {
            if (!t.isImportSpecifier(specifier)) continue;
            const imported = importedName(specifier);
            if (isBindingKind(imported)) {
                decorators.set(specifier.local.name, imported);
            } else if (imported === 'namespace') {
                for (const reference of scope.getBinding(specifier.local.name)?.referencePaths ?? []) {
                    const call = reference.parentPath;
                    const declarator = call?.parentPath;
                    if (!call?.isCallExpression() || call.node.callee !== reference.node) continue;
                    if (!declarator?.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) continue;
                    const [argument] = call.get('arguments');
                    const namespace = argument ? resolveString(argument, unit, ctx) : null;
                    if (namespace === null) continue;
                    namespaces.set(declarator.node.id.name, normalizeNamespace(namespace));
                    namespaceDeclarators.push(declarator);
                }
            }
        }
    }

    const properties: NodePath<t.ClassProperty>[] = [];
    unit.program.traverse({
        ClassProperty(path) {
            if (path.node.decorators?.length) properties.push(path);
        },
    });

    const describe = (expression: NodePath): DecoratorInfo | null => {
        let callee = expression;
        let argument: NodePath | null = null;
        if (expression.isCallExpression()) {
            callee = expression.get('callee') as NodePath;
            argument = (expression.get('arguments') as NodePath[])[0] ?? null;
        }

        if (callee.isIdentifier()) {
            const kind = decorators.get(callee.node.name);
            return kind ? { kind, namespace: '', argument } : null;
        }
        if (callee.isMemberExpression() && t.isIdentifier(callee.node.object)) {
            const namespace = namespaces.get(callee.node.object.name);
            const kind = staticKeyName(callee.node.property, callee.node.computed);
            return namespace !== undefined && isBindingKind(kind) ? { kind, namespace, argument } : null;
        }
        return null;
    };

    const refs = ctx.refs(unit);
    const isTypeScript = unit.lang === 'ts' || unit.lang === 'tsx';

    for (const property of properties) {
        const node = property.node;
        const decoratorPaths = property.get('decorators') as NodePath<t.Decorator>[];
        const index = decoratorPaths.findIndex((d) => describe(d.get('expression') as NodePath) !== null);
        if (index === -1 || !t.isIdentifier(node.key) || node.computed) continue;

        const info = describe(decoratorPaths[index]!.get('expression') as NodePath)!;
        const propertyName = node.key.name;
        const kind = KINDS[info.kind];
        const fail = (message: string): void => {
            addLeadingComment(node, `${TODO_PREFIX}: ${message}`);
            ctx.report.todo(unit.file.path, message, node.loc?.start.line);
        };

        const argument = info.argument ? unwrapPath(info.argument) : null;
        const name = argument && !isFunctionNode(argument.node) ? resolveString(argument, unit, ctx) : propertyName;
        if (name === null) {
            fail(`@${info.kind}: the bound name is not a static string — convert this binding manually`);
            continue;
        }

        let body: t.Expression | null = null;
        let isMethod = false;
        let parameters: t.ClassMethod['params'] = [];
        let returnType: t.ClassMethod['returnType'] = null;

        if (kind === 'state') {
            const base = ctx.model.moduleByNamespace(info.namespace);
            if (!base) {
                fail(`@State: no module is registered under the namespace "${info.namespace}" — convert this binding manually`);
                continue;
            }

            if (argument && isFunctionNode(argument.node)) {
                const fn = argument as NodePath<t.Function>;
                const [param] = fn.get('params') as NodePath[];
                if (!fn.isArrowFunctionExpression() || t.isBlockStatement(fn.node.body) || (param && !param.isIdentifier())) {
                    fail('@State with a function that is not a simple arrow expression — convert this binding manually');
                    continue;
                }
                const rewriter = new Rewriter(ctx, unit, (module) => refs.inline(module));
                if (param?.isIdentifier()) rewriter.rewriteBinding(fn, param.node.name, { kind: 'state', module: base });
                rewriter.flush();
                body = fn.node.body as t.Expression;
            } else {
                const child = base.children.get(name);
                if (child?.hasStore) body = t.memberExpression(refs.inline(child), t.identifier('$state'));
                else if (!child && base.hasStore) body = memberAccess(refs.inline(base), name);
            }
        } else {
            const [target] = ctx.model.findMembers(kind, info.namespace + name);
            if (target) {
                const access = memberAccess(refs.inline(target.module), target.name);
                if (kind === 'getters') {
                    body = access;
                } else {
                    isMethod = true;
                    const annotation = t.isTSTypeAnnotation(node.typeAnnotation) ? node.typeAnnotation.typeAnnotation : null;
                    if (t.isTSFunctionType(annotation) && annotation.parameters.every((p) => t.isIdentifier(p))) {
                        parameters = annotation.parameters as t.Identifier[];
                        // a fresh wrapper: the original one is printed as `=> T`
                        returnType = annotation.typeAnnotation ? t.tsTypeAnnotation(annotation.typeAnnotation.typeAnnotation) : null;
                        body = t.callExpression(access, (parameters as t.Identifier[]).map((p) => t.identifier(p.name)));
                    } else {
                        const rest = t.restElement(t.identifier('args'));
                        if (isTypeScript) rest.typeAnnotation = t.tsTypeAnnotation(t.tsArrayType(t.tsAnyKeyword()));
                        parameters = [rest];
                        body = t.callExpression(access, [t.spreadElement(t.identifier('args'))]);
                    }
                }
            }
        }

        if (!body) {
            fail(`@${info.kind}: "${info.namespace}${name}" could not be matched to a Pinia store — convert this binding manually`);
            continue;
        }

        const method = t.classMethod(isMethod ? 'method' : 'get', t.identifier(propertyName), parameters, t.blockStatement([t.returnStatement(body)]));
        if (isMethod) method.returnType = returnType;
        else if (t.isTSTypeAnnotation(node.typeAnnotation)) method.returnType = node.typeAnnotation;
        method.accessibility = node.accessibility;
        method.static = node.static;
        const others = (node.decorators ?? []).filter((_, i) => i !== index);
        if (others.length > 0) method.decorators = others;
        moveComments(node, method);

        const classBody = property.parent as t.ClassBody;
        const position = classBody.body.indexOf(node);
        if (position !== -1) classBody.body[position] = method;
    }

    const stillUsed = new Set<string>();
    t.traverseFast(unit.ast, (current) => {
        if (t.isDecorator(current)) {
            t.traverseFast(current, (inner) => {
                if (t.isIdentifier(inner)) stillUsed.add(inner.name);
            });
        }
    });
    for (const declarator of namespaceDeclarators) {
        const name = (declarator.node.id as t.Identifier).name;
        const binding = declarator.scope.getBinding(name);
        const onlyDecorators = binding?.referencePaths.every((reference) => !!reference.findParent((p) => p.isDecorator()));
        if (stillUsed.has(name) || !onlyDecorators) continue;
        const declaration = declarator.parentPath;
        if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 1) declaration.remove();
        else declarator.remove();
    }
}
