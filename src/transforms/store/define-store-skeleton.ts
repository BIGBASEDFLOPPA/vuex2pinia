import * as t from '@babel/types';
import { traverse } from '../../core/babel-interop.js';
import { convertVuexActionMethod } from './convert-vuex-action.js';
import type { StoreTransform } from '../../core/store-transform-runner.js';

export function createDefineStoreSkeleton(pathSegments: string[]): StoreTransform {
    const storeId = pathSegments.join('/');
    const exportName = `use${pathSegments.map(capitalize).join('')}Store`;

    return (ast: t.File): void => {
        traverse(ast, {
            ExportDefaultDeclaration(path) {
                const declaration = path.node.declaration;
                if (!t.isObjectExpression(declaration)) return;

                const newOptionsObject = buildPiniaOptionsObject(declaration);
                const defineStoreCall = t.callExpression(t.identifier('defineStore'), [
                    t.stringLiteral(storeId),
                    newOptionsObject,
                ]);

                const exportDeclaration = t.exportNamedDeclaration(
                    t.variableDeclaration('const', [
                        t.variableDeclarator(t.identifier(exportName), defineStoreCall),
                    ]),
                );

                path.replaceWith(exportDeclaration);
            },
        });

        ensureDefineStoreImport(ast);
    };
}

function buildPiniaOptionsObject(vuexModule: t.ObjectExpression): t.ObjectExpression {
    const properties = new Map<string, t.ObjectExpression['properties'][number]>();

    for (const prop of vuexModule.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        properties.set(prop.key.name, prop);
    }

    const result: t.ObjectExpression['properties'] = [];

    const stateProp = properties.get('state');
    if (stateProp) result.push(stateProp);

    const gettersProp = properties.get('getters');
    if (gettersProp) result.push(gettersProp);

    const mergedActions = buildMergedActions(properties.get('mutations'), properties.get('actions'));
    if (mergedActions) {
        result.push(t.objectProperty(t.identifier('actions'), mergedActions));
    }

    return t.objectExpression(result);
}

function buildMergedActions(
    mutationsProp: t.ObjectExpression['properties'][number] | undefined,
    actionsProp: t.ObjectExpression['properties'][number] | undefined,
): t.ObjectExpression | null {
    const actionMethods: t.ObjectMethod[] = [];

    if (mutationsProp && t.isObjectProperty(mutationsProp) && t.isObjectExpression(mutationsProp.value)) {
        for (const method of mutationsProp.value.properties) {
            if (t.isObjectMethod(method)) {
                actionMethods.push(convertMutationToAction(method));
            }
        }
    }

    if (actionsProp && t.isObjectProperty(actionsProp) && t.isObjectExpression(actionsProp.value)) {
        for (const method of actionsProp.value.properties) {
            if (t.isObjectMethod(method)) {
                actionMethods.push(convertVuexActionMethod(method));
            }
        }
    }

    if (actionMethods.length === 0) return null;
    return t.objectExpression(actionMethods);
}

function convertMutationToAction(method: t.ObjectMethod): t.ObjectMethod {
    const [stateParam, ...restParams] = method.params;

    if (stateParam && t.isIdentifier(stateParam)) {
        const stateParamName = stateParam.name;

        traverse(method, {
            noScope: true,
            Identifier(path) {
                if (path.node.name !== stateParamName) return;
                if (!path.isReferencedIdentifier()) return;
                path.replaceWith(t.thisExpression());
            },
        });

        method.params = restParams;
    }

    return method;
}

function ensureDefineStoreImport(ast: t.File): void {
    const hasImport = ast.program.body.some(
        (node) =>
            t.isImportDeclaration(node) &&
            node.source.value === 'pinia' &&
            node.specifiers.some((s) => t.isImportSpecifier(s) && t.isIdentifier(s.imported, { name: 'defineStore' })),
    );

    if (hasImport) return;

    const importDeclaration = t.importDeclaration(
        [t.importSpecifier(t.identifier('defineStore'), t.identifier('defineStore'))],
        t.stringLiteral('pinia'),
    );

    ast.program.body.unshift(importDeclaration);
}

function capitalize(segment: string): string {
    return segment.charAt(0).toUpperCase() + segment.slice(1);
}