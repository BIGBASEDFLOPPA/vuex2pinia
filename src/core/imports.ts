import { moveComments, t } from './ast.js';
import type { ScriptUnit } from './project.js';

/**
 * Names that are referenced somewhere in the file — including type positions,
 * which Babel's scope tracking ignores. Purely name based (shadowing counts as
 * a use), which errs on the side of keeping an import.
 */
export function collectUsedNames(ast: t.File): Set<string> {
    const used = new Set<string>();

    // A hand-rolled walk: a `noScope` Babel traversal would leave scope-less paths in Babel's path cache.
    const visit = (node: t.Node, parent: t.Node | null, key: string): void => {
        if ((t.isIdentifier(node) || t.isJSXIdentifier(node)) && parent && isUse(parent, key)) used.add(node.name);

        for (const childKey of t.VISITOR_KEYS[node.type] ?? []) {
            const child = (node as unknown as Record<string, t.Node | (t.Node | null)[] | null | undefined>)[childKey];
            if (Array.isArray(child)) {
                for (const item of child) if (item) visit(item, node, childKey);
            } else if (child) {
                visit(child, node, childKey);
            }
        }
    };

    visit(ast.program, null, '');
    return used;
}

function isUse(parent: t.Node, key: string): boolean {
    if (t.isImportSpecifier(parent) || t.isImportDefaultSpecifier(parent) || t.isImportNamespaceSpecifier(parent)) return false;
    if ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && key === 'property' && !parent.computed) return false;
    if (t.isJSXMemberExpression(parent) && key === 'property') return false;
    if (t.isJSXAttribute(parent) && key === 'name') return false;
    if (t.isExportSpecifier(parent) && key === 'exported') return false;
    if (t.isTSQualifiedName(parent) && key === 'right') return false;
    if ((t.isLabeledStatement(parent) || t.isBreakStatement(parent) || t.isContinueStatement(parent)) && key === 'label') return false;

    // `{ a }` shorthand: the value node is visited separately
    const isMemberKey =
        key === 'key' &&
        (t.isObjectProperty(parent) ||
            t.isObjectMethod(parent) ||
            t.isClassMethod(parent) ||
            t.isClassProperty(parent) ||
            t.isTSPropertySignature(parent) ||
            t.isTSMethodSignature(parent));
    if (isMemberKey && !(parent as { computed?: boolean }).computed) return false;

    return true;
}

function importDeclarations(unit: ScriptUnit): t.ImportDeclaration[] {
    return unit.ast.program.body.filter((node): node is t.ImportDeclaration => t.isImportDeclaration(node));
}

export function importedName(specifier: t.ImportSpecifier): string {
    return t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
}

export function ensureNamedImport(unit: ScriptUnit, source: string, name: string, local: string = name): void {
    const declarations = importDeclarations(unit);

    for (const declaration of declarations) {
        if (declaration.source.value !== source || declaration.importKind === 'type') continue;
        const exists = declaration.specifiers.some(
            (s) => t.isImportSpecifier(s) && s.importKind !== 'type' && importedName(s) === name && s.local.name === local,
        );
        if (exists) return;
    }

    const specifier = t.importSpecifier(t.identifier(local), t.identifier(name));

    const mergeTarget = declarations.find(
        (d) =>
            d.source.value === source &&
            d.importKind !== 'type' &&
            !d.specifiers.some((s) => t.isImportNamespaceSpecifier(s)),
    );
    if (mergeTarget) {
        mergeTarget.specifiers.push(specifier);
        return;
    }

    const declaration = t.importDeclaration([specifier], t.stringLiteral(source));
    const body = unit.ast.program.body;
    const lastImport = declarations[declarations.length - 1];

    if (lastImport) {
        body.splice(body.indexOf(lastImport) + 1, 0, declaration);
    } else {
        body.unshift(declaration);
    }
}

/** Removes a top-level statement, keeping a leading (license / description) comment alive. */
export function removeStatement(body: t.Statement[], statement: t.Statement): void {
    const index = body.indexOf(statement);
    if (index === -1) return;

    const next = body[index + 1];
    if (index === 0 && next) moveComments(statement, next);
    body.splice(index, 1);
}

/** Drops import specifiers whose last use was removed by the migration. */
export function removeOrphanedImports(unit: ScriptUnit): void {
    const used = collectUsedNames(unit.ast);
    const body = unit.ast.program.body;

    for (const declaration of importDeclarations(unit)) {
        if (declaration.specifiers.length === 0) continue;

        declaration.specifiers = declaration.specifiers.filter((specifier) => {
            const local = specifier.local.name;
            return used.has(local) || !unit.initiallyUsed.has(local);
        });

        if (declaration.specifiers.length === 0) removeStatement(body, declaration);
    }
}

export function importsFrom(unit: ScriptUnit, source: string): t.ImportDeclaration[] {
    return importDeclarations(unit).filter((d) => d.source.value === source);
}

export function importSources(unit: ScriptUnit): string[] {
    return importDeclarations(unit).map((d) => d.source.value);
}
