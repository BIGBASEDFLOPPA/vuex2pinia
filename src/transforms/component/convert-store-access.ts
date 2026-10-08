import { isCallLike, isMemberLike, staticKeyName, t, unwrapNode, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import { importedName } from '../../core/imports.js';
import type { ScriptUnit } from '../../core/project.js';
import { placeInInnermostFunction, placeInThisOwner } from '../shared/placement.js';
import { Rewriter } from '../shared/rewriter.js';

export function convertStoreAccess(ctx: MigrationContext, unit: ScriptUnit): void {
    convertInstanceProperty(ctx, unit);
    convertUseStore(ctx, unit);
    convertImportedStore(ctx, unit);
    if (unit === ctx.model.rootUnit) convertLocalStore(ctx, unit);
}

function convertInstanceProperty(ctx: MigrationContext, unit: ScriptUnit): void {
    const refs = ctx.refs(unit);
    const found: NodePath[] = [];

    unit.program.traverse({
        'MemberExpression|OptionalMemberExpression'(path: NodePath) {
            const node = path.node as t.MemberExpression;
            if (staticKeyName(node.property, node.computed) === '$store') found.push(path);
        },
        StringLiteral(path) {
            if (!path.node.value.startsWith('$store.')) return;
            new Rewriter(ctx, unit, placeInThisOwner(refs)).todo(
                path,
                '"' + path.node.value + '" is watched by its string path, which Pinia cannot offer — watch a function that reads the Pinia store instead',
            );
        },
    });
    if (found.length === 0) return;

    const onThis = new Rewriter(ctx, unit, placeInThisOwner(refs));
    const onOther = new Rewriter(ctx, unit, placeInInnermostFunction(refs));

    for (const path of found) {
        const object = unwrapNode((path.node as t.MemberExpression).object);
        (t.isThisExpression(object) ? onThis : onOther).rewriteStore(path);
    }

    onThis.flush();
    onOther.flush();
}

function isVuexOrRootStore(ctx: MigrationContext, unit: ScriptUnit, source: string): boolean {
    if (source === 'vuex') return true;
    return ctx.resolver.resolveImport(source, unit.file.path) === ctx.model.rootFile;
}

function convertUseStore(ctx: MigrationContext, unit: ScriptUnit): void {
    const refs = ctx.refs(unit);
    const calls: NodePath<t.CallExpression>[] = [];

    for (const statement of unit.ast.program.body) {
        if (!t.isImportDeclaration(statement) || !isVuexOrRootStore(ctx, unit, statement.source.value)) continue;

        for (const specifier of statement.specifiers) {
            if (!t.isImportSpecifier(specifier) || importedName(specifier) !== 'useStore') continue;
            const binding = unit.program.scope.getBinding(specifier.local.name);
            for (const reference of binding?.referencePaths ?? []) {
                const call = reference.parentPath;
                if (call?.isCallExpression() && call.node.callee === reference.node) calls.push(call);
            }
        }
    }

    for (const call of calls) {
        let value: NodePath = call;
        while (value.parentPath && unwrapNode(value.parentPath.node) !== value.parentPath.node) value = value.parentPath;

        const declarator = value.parentPath;
        const isDeclared = !!declarator?.isVariableDeclarator() && declarator.node.init === value.node;
        const statement = isDeclared ? declarator.parentPath : null;

        if (!isDeclared || !statement?.isVariableDeclaration() || !statement.parentPath.isBlockParent()) {
            const rewriter = new Rewriter(ctx, unit, placeInInnermostFunction(refs));
            rewriter.rewriteStore(value);
            rewriter.flush();
            continue;
        }

        const rewriter = new Rewriter(ctx, unit, (module) => refs.declareBefore(module, statement));
        const id = declarator.get('id') as NodePath;

        if (id.isIdentifier()) {
            const converted = rewriter.rewriteBinding(declarator, id.node.name, { kind: 'store' });
            rewriter.flush();
            if (converted) {
                if (unit.kind === 'scriptSetup' && statement.parentPath.isProgram()) unit.file.templateStoreNames.add(id.node.name);
                if (statement.node.declarations.length === 1) statement.remove();
                else declarator.remove();
            }
        } else {
            if (value !== call) declarator.node.init = call.node;
            rewriter.rewriteStore(declarator.get('init') as NodePath);
            rewriter.flush();
        }
    }
}

function convertImportedStore(ctx: MigrationContext, unit: ScriptUnit): void {
    const { model } = ctx;
    if (model.storeExports.size === 0) return;

    for (const statement of unit.ast.program.body) {
        if (!t.isImportDeclaration(statement) || statement.importKind === 'type') continue;
        if (ctx.resolver.resolveImport(statement.source.value, unit.file.path) !== model.rootFile) continue;

        for (const specifier of statement.specifiers) {
            const exported = t.isImportDefaultSpecifier(specifier)
                ? 'default'
                : t.isImportSpecifier(specifier)
                  ? importedName(specifier)
                  : null;
            if (exported === null || !model.storeExports.has(exported)) continue;
            convertStoreBinding(ctx, unit, specifier.local.name);
        }
    }
}

function convertLocalStore(ctx: MigrationContext, unit: ScriptUnit): void {
    unit.program.traverse({
        VariableDeclarator(path) {
            const init = path.node.init ? unwrapNode(path.node.init) : null;
            if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: 'createPinia' })) return;
            const holder = path.parentPath.parentPath;
            if (!t.isIdentifier(path.node.id) || !(holder?.isProgram() || holder?.isExportNamedDeclaration())) return;
            convertStoreBinding(ctx, unit, path.node.id.name);
        },
    });
}

function convertStoreBinding(ctx: MigrationContext, unit: ScriptUnit, localName: string): void {
    const binding = unit.program.scope.getBinding(localName);
    if (!binding) return;

    const refs = ctx.refs(unit);
    const rewriter = new Rewriter(ctx, unit, placeInInnermostFunction(refs, t.identifier(localName)));

    for (const reference of binding.referencePaths) {
        const parent = reference.parentPath;
        if (!parent || !reference.isIdentifier()) continue;

        if (parent.isObjectProperty() && parent.node.value === reference.node && staticKeyName(parent.node.key, parent.node.computed) === 'store') {
            parent.node.key = t.identifier('pinia');
            parent.node.shorthand = false;
            parent.node.computed = false;
            continue;
        }

        if (isCallLike(parent.node) && parent.node.arguments.includes(reference.node as t.Expression)) {
            const callee = parent.node.callee;
            if (isMemberLike(callee) && staticKeyName(callee.property, callee.computed) === 'use') continue;
        }

        if (parent.isExportDefaultDeclaration() || parent.isExportSpecifier()) continue;

        const isAccess = isMemberLike(parent.node) && parent.node.object === reference.node;
        if (!isAccess && !parent.isVariableDeclarator()) {
            rewriter.warn(reference, `"${localName}" is the Pinia instance now (it used to be the Vuex store) — review how it is used here`);
            continue;
        }

        rewriter.rewriteStore(reference);
    }

    rewriter.flush();
}
