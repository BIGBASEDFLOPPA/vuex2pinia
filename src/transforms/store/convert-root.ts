import { TODO_PREFIX, addLeadingComment, commentAnchor, lineOf, staticKeyName, t, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import { ensureNamedImport, removeStatement } from '../../core/imports.js';

export function convertRootFile(ctx: MigrationContext): void {
    const { model } = ctx;
    const creation = model.creationPath;
    const unit = model.rootUnit;
    if (!creation || !unit) return;

    const file = unit.file.path;

    const options = model.root.def?.objectPath?.node;
    const hasPlugins = options?.properties.some((p) => !t.isSpreadElement(p) && staticKeyName(p.key, p.computed) === 'plugins');
    if (hasPlugins) {
        const message = 'Vuex plugins were removed with the store — port them to Pinia plugins (`pinia.use(...)`)';
        addLeadingComment(commentAnchor(creation), `${TODO_PREFIX}: ${message}`);
        ctx.report.todo(file, message, lineOf(creation.node));
    }

    // `const store: Store<RootState> = createStore(...)` — the annotation no longer applies
    const declarator = creation.parentPath;
    if (declarator?.isVariableDeclarator() && t.isIdentifier(declarator.node.id)) declarator.node.id.typeAnnotation = null;

    // `const options = {...}; new Vuex.Store(options)` — the options object is dead once the store is gone
    const [argument] = creation.get('arguments') as NodePath[];
    if (argument?.isIdentifier()) {
        const binding = argument.scope.getBinding(argument.node.name);
        const declaration = binding?.path.parentPath;
        const isOnlyUse = binding?.referencePaths.length === 1 && binding.path.isVariableDeclarator();
        if (isOnlyUse && declaration?.isVariableDeclaration() && declaration.node.declarations.length === 1 && declaration.parentPath.isProgram()) {
            removeStatement(unit.ast.program.body, declaration.node);
        }
    }

    creation.replaceWith(t.callExpression(t.identifier('createPinia'), []));
    ensureNamedImport(unit, 'pinia', 'createPinia');

    // `Vue.use(Vuex)` (Vue 2)
    const installs: NodePath<t.CallExpression>[] = [];
    unit.program.traverse({
        CallExpression(path) {
            const callee = path.node.callee;
            if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: 'use' })) return;
            const [argument] = path.get('arguments');
            if (!argument?.isIdentifier()) return;
            const binding = argument.scope.getBinding(argument.node.name);
            const declaration = binding?.path.parent;
            if (t.isImportDeclaration(declaration) && declaration.source.value === 'vuex') installs.push(path);
        },
    });

    for (const install of installs) {
        if (model.vueVersion === 2) {
            install.node.arguments = [t.identifier('PiniaVuePlugin')];
            ensureNamedImport(unit, 'pinia', 'PiniaVuePlugin');
        } else if (install.parentPath.isExpressionStatement() && install.parentPath.parentPath.isProgram()) {
            removeStatement(unit.ast.program.body, install.parentPath.node);
        }
    }
}
