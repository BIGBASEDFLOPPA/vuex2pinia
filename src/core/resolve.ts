import { isMemberLike, staticKeyName, t, unwrapPath, type NodePath } from './ast.js';
import { importedName } from './imports.js';
import type { PathResolver } from './path-resolver.js';
import type { Project, ScriptUnit } from './project.js';

export interface ResolveEnv {
    project: Project;
    resolver: PathResolver;
}

export type Resolved =
    | { kind: 'value'; path: NodePath; unit: ScriptUnit }
    /** `import * as x from './file'` — the whole module namespace of `unit`. */
    | { kind: 'namespace'; unit: ScriptUnit };

const MAX_DEPTH = 12;

/** Follows identifiers, imports and member accesses to the expression that defines a value. */
export function resolveValue(path: NodePath, unit: ScriptUnit, env: ResolveEnv, depth = 0): Resolved | null {
    if (depth > MAX_DEPTH) return null;
    const current = unwrapPath(path);

    if (current.isIdentifier()) {
        const binding = current.scope.getBinding(current.node.name);
        if (!binding) return null;
        return resolveBindingPath(binding.path, unit, env, depth);
    }

    if (isMemberLike(current.node)) {
        const key = staticKeyName(current.node.property, current.node.computed);
        if (key === null) return { kind: 'value', path: current, unit };

        const object = resolveValue(current.get('object') as NodePath, unit, env, depth + 1);
        if (!object) return null;
        if (object.kind === 'namespace') return getExport(object.unit, key, env, depth + 1);

        const member = findMember(object.path, key);
        return member ? resolveValue(member, object.unit, env, depth + 1) : null;
    }

    return { kind: 'value', path: current, unit };
}

function resolveBindingPath(bindingPath: NodePath, unit: ScriptUnit, env: ResolveEnv, depth: number): Resolved | null {
    if (bindingPath.isVariableDeclarator()) {
        if (!bindingPath.get('id').isIdentifier()) return null;
        const init = bindingPath.get('init');
        if (!init.node) return null;
        return resolveValue(init as NodePath, unit, env, depth + 1);
    }

    if (bindingPath.isFunctionDeclaration() || bindingPath.isTSEnumDeclaration() || bindingPath.isClassDeclaration()) {
        return { kind: 'value', path: bindingPath, unit };
    }

    if (
        bindingPath.isImportSpecifier() ||
        bindingPath.isImportDefaultSpecifier() ||
        bindingPath.isImportNamespaceSpecifier()
    ) {
        const declaration = bindingPath.parent as t.ImportDeclaration;
        const targetFile = env.resolver.resolveImport(declaration.source.value, unit.file.path);
        if (!targetFile) return null;

        const targetUnit = env.project.moduleUnit(targetFile);
        if (!targetUnit) return null;

        if (bindingPath.isImportNamespaceSpecifier()) return { kind: 'namespace', unit: targetUnit };
        if (bindingPath.isImportDefaultSpecifier()) return getExport(targetUnit, 'default', env, depth + 1);
        return getExport(targetUnit, importedName(bindingPath.node as t.ImportSpecifier), env, depth + 1);
    }

    return null;
}

function findMember(objectPath: NodePath, key: string): NodePath | null {
    if (objectPath.isObjectExpression()) {
        for (const property of objectPath.get('properties')) {
            if (property.isObjectProperty() && staticKeyName(property.node.key, property.node.computed) === key) {
                return property.get('value') as NodePath;
            }
            if (property.isObjectMethod() && staticKeyName(property.node.key, property.node.computed) === key) {
                return property;
            }
        }
        return null;
    }

    if (objectPath.isTSEnumDeclaration()) {
        const body = objectPath.get('body') as NodePath;
        const members = (body.isTSEnumBody?.() ? body.get('members') : objectPath.get('members')) as NodePath[];
        for (const member of [members].flat()) {
            const node = member.node as t.TSEnumMember;
            const name = t.isIdentifier(node.id) ? node.id.name : node.id.value;
            if (name === key && node.initializer) return member.get('initializer') as NodePath;
        }
    }

    return null;
}

/** Finds what a module exports under `name` (use `default` for the default export). */
export function getExport(unit: ScriptUnit, name: string, env: ResolveEnv, depth = 0): Resolved | null {
    if (depth > MAX_DEPTH) return null;

    for (const statement of unit.program.get('body')) {
        if (statement.isExportDefaultDeclaration()) {
            if (name !== 'default') continue;
            const declaration = statement.get('declaration') as NodePath;
            if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration()) {
                return { kind: 'value', path: declaration, unit };
            }
            return resolveValue(declaration, unit, env, depth + 1);
        }

        if (statement.isExportNamedDeclaration()) {
            const declaration = statement.get('declaration') as NodePath;

            if (declaration.isVariableDeclaration()) {
                for (const declarator of declaration.get('declarations')) {
                    if (!t.isIdentifier(declarator.node.id, { name })) continue;
                    const init = declarator.get('init');
                    return init.node ? resolveValue(init as NodePath, unit, env, depth + 1) : null;
                }
            } else if (
                (declaration.isFunctionDeclaration() || declaration.isTSEnumDeclaration() || declaration.isClassDeclaration()) &&
                t.isIdentifier(declaration.node.id, { name })
            ) {
                return { kind: 'value', path: declaration, unit };
            }

            for (const specifier of statement.get('specifiers')) {
                if (!specifier.isExportSpecifier()) continue;
                const exported = specifier.node.exported;
                const exportedName = t.isIdentifier(exported) ? exported.name : exported.value;
                if (exportedName !== name) continue;

                const source = statement.node.source;
                if (source) {
                    const target = resolveUnit(source.value, unit, env);
                    return target ? getExport(target, specifier.node.local.name, env, depth + 1) : null;
                }
                return resolveValue(specifier.get('local') as NodePath, unit, env, depth + 1);
            }
        }

        if (statement.isExportAllDeclaration() && name !== 'default') {
            const target = resolveUnit(statement.node.source.value, unit, env);
            const found = target ? getExport(target, name, env, depth + 1) : null;
            if (found) return found;
        }
    }

    return null;
}

/** Names of everything a module exports directly (used for `import * as x` style modules). */
export function exportedNames(unit: ScriptUnit, env: ResolveEnv, depth = 0): string[] {
    const names: string[] = [];
    if (depth > MAX_DEPTH) return names;

    for (const statement of unit.ast.program.body) {
        if (t.isExportNamedDeclaration(statement)) {
            const declaration = statement.declaration;
            if (t.isVariableDeclaration(declaration)) {
                for (const declarator of declaration.declarations) {
                    if (t.isIdentifier(declarator.id)) names.push(declarator.id.name);
                }
            } else if ((t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) && declaration.id) {
                names.push(declaration.id.name);
            }
            for (const specifier of statement.specifiers) {
                if (!t.isExportSpecifier(specifier)) continue;
                const exported = specifier.exported;
                names.push(t.isIdentifier(exported) ? exported.name : exported.value);
            }
        } else if (t.isExportAllDeclaration(statement)) {
            const target = resolveUnit(statement.source.value, unit, env);
            if (target) names.push(...exportedNames(target, env, depth + 1));
        }
    }

    return names.filter((n) => n !== 'default');
}

function resolveUnit(specifier: string, unit: ScriptUnit, env: ResolveEnv): ScriptUnit | null {
    const file = env.resolver.resolveImport(specifier, unit.file.path);
    return file ? env.project.moduleUnit(file) : null;
}

/** Statically evaluates a string expression (literals, constants, imported constants, concatenation). */
export function resolveString(path: NodePath, unit: ScriptUnit, env: ResolveEnv, depth = 0): string | null {
    if (depth > MAX_DEPTH) return null;
    const current = unwrapPath(path);

    if (current.isStringLiteral()) return current.node.value;

    if (current.isTemplateLiteral()) {
        const quasis = current.node.quasis;
        const expressions = current.get('expressions') as NodePath[];
        let result = '';
        for (let i = 0; i < quasis.length; i++) {
            result += quasis[i]?.value.cooked ?? '';
            const expression = expressions[i];
            if (expression) {
                const value = resolveString(expression, unit, env, depth + 1);
                if (value === null) return null;
                result += value;
            }
        }
        return result;
    }

    if (current.isBinaryExpression({ operator: '+' })) {
        const left = resolveString(current.get('left') as NodePath, unit, env, depth + 1);
        const right = resolveString(current.get('right') as NodePath, unit, env, depth + 1);
        return left === null || right === null ? null : left + right;
    }

    if (current.isIdentifier() || isMemberLike(current.node)) {
        const resolved = resolveValue(current, unit, env, depth + 1);
        if (!resolved || resolved.kind !== 'value' || resolved.path === current) return null;
        return resolveString(resolved.path, resolved.unit, env, depth + 1);
    }

    return null;
}
