import { readFile, access } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { parse } from '@babel/parser';
import { traverse } from './babel-interop.js';
import * as t from '@babel/types';

export interface ResolvedStoreModule {
    filePath: string;
    namespace: string;
    pathSegments: string[];
    namespaced: boolean;
}

export interface UnresolvedStoreModule {
    key: string;
    pathSegments: string[];
    reason: string;
}

export interface StoreResolveResult {
    resolved: ResolvedStoreModule[];
    unresolved: UnresolvedStoreModule[];
}

const CANDIDATE_EXTENSIONS = ['.ts', '.js', '/index.ts', '/index.js'];

export async function resolveStoreModules(rootStoreFilePath: string): Promise<StoreResolveResult> {
    const resolved: ResolvedStoreModule[] = [];
    const unresolved: UnresolvedStoreModule[] = [];

    await collectModules(rootStoreFilePath, [], resolved, unresolved);

    return { resolved, unresolved };
}

async function collectModules(
    filePath: string,
    parentSegments: string[],
    resolved: ResolvedStoreModule[],
    unresolved: UnresolvedStoreModule[],
): Promise<void> {
    const source = await readFile(filePath, 'utf-8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });

    const importMap = buildImportMap(ast);
    const modulesObject = findModulesObject(ast);

    if (!modulesObject) return;

    for (const property of modulesObject.properties) {
        if (!t.isObjectProperty(property) || !t.isIdentifier(property.key)) continue;

        const key = property.key.name;
        const segments = [...parentSegments, key];

        if (t.isIdentifier(property.value)) {
            const importedFrom = importMap.get(property.value.name);
            if (!importedFrom) {
                unresolved.push({
                    key,
                    pathSegments: segments,
                    reason: `"${key}" references identifier "${property.value.name}" which is not a traceable import`,
                });
                continue;
            }

            const moduleFilePath = await resolveImportPath(importedFrom, filePath);
            if (!moduleFilePath) {
                unresolved.push({
                    key,
                    pathSegments: segments,
                    reason: `could not resolve import "${importedFrom}" to a file on disk`,
                });
                continue;
            }

            const namespaced = await moduleDeclaresNamespaced(moduleFilePath);

            resolved.push({
                filePath: moduleFilePath,
                namespace: segments.join('/'),
                pathSegments: segments,
                namespaced,
            });

            await collectModules(moduleFilePath, segments, resolved, unresolved);
            continue;
        }

        if (t.isObjectExpression(property.value)) {
            unresolved.push({
                key,
                pathSegments: segments,
                reason: `"${key}" is defined inline in ${filePath} rather than as a separate file — handle manually`,
            });
            continue;
        }

        unresolved.push({
            key,
            pathSegments: segments,
            reason: `"${key}" has an expression the resolver doesn't understand (dynamic value?)`,
        });
    }
}

function buildImportMap(ast: t.File): Map<string, string> {
    const map = new Map<string, string>();

    traverse(ast, {
        ImportDeclaration(path) {
            const source = path.node.source.value;
            for (const specifier of path.node.specifiers) {
                if (t.isImportDefaultSpecifier(specifier) || t.isImportSpecifier(specifier)) {
                    map.set(specifier.local.name, source);
                }
            }
        },
    });

    return map;
}

function findModulesObject(ast: t.File): t.ObjectExpression | null {
    const configObject = findRootStoreCallObject(ast) ?? findExportDefaultObject(ast);
    if (!configObject) return null;

    const modulesProp = configObject.properties.find(
        (p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: 'modules' }),
    );

    return modulesProp && t.isObjectExpression(modulesProp.value) ? modulesProp.value : null;
}

function findRootStoreCallObject(ast: t.File): t.ObjectExpression | null {
    let configObject: t.ObjectExpression | null = null;

    function checkArguments(args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[]): void {
        const arg = args[0];
        if (t.isObjectExpression(arg)) configObject = arg;
    }

    traverse(ast, {
        CallExpression(path) {
            if (t.isIdentifier(path.node.callee, { name: 'createStore' })) {
                checkArguments(path.node.arguments);
            }
        },
        NewExpression(path) {
            const callee = path.node.callee;
            const isVuexStore = t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'Store' });
            if (isVuexStore) {
                checkArguments(path.node.arguments);
            }
        },
    });

    return configObject;
}

function findExportDefaultObject(ast: t.File): t.ObjectExpression | null {
    let exportedObject: t.ObjectExpression | null = null;

    traverse(ast, {
        ExportDefaultDeclaration(path) {
            if (t.isObjectExpression(path.node.declaration)) {
                exportedObject = path.node.declaration;
            }
        },
    });

    return exportedObject;
}

async function moduleDeclaresNamespaced(filePath: string): Promise<boolean> {
    const source = await readFile(filePath, 'utf-8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });

    let namespaced = false;

    traverse(ast, {
        ObjectProperty(path) {
            const isNamespacedKey = t.isIdentifier(path.node.key, { name: 'namespaced' });
            if (isNamespacedKey && t.isBooleanLiteral(path.node.value, { value: true })) {
                namespaced = true;
            }
        },
    });

    return namespaced;
}

async function resolveImportPath(specifier: string, fromFile: string): Promise<string | null> {
    if (!specifier.startsWith('.')) return null; // skip package imports like 'vuex' itself

    const base = resolve(dirname(fromFile), specifier);

    if (extname(base)) {
        return (await fileExists(base)) ? base : null;
    }

    for (const suffix of CANDIDATE_EXTENSIONS) {
        const candidate = base + suffix;
        if (await fileExists(candidate)) return candidate;
    }

    return null;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}