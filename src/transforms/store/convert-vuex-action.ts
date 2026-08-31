import * as t from '@babel/types';
import { traverse } from '../../core/babel-interop.js';

type ClassifiedCall = { path: { node: t.CallExpression; replaceWith: (node: t.Node) => void }; targetName: string };

export function convertVuexActionMethod(method: t.ObjectMethod): t.ObjectMethod {
    const [contextParam] = method.params;
    if (!contextParam) return method;

    let contextBindings: Map<string, string> | null = null;
    let contextIdentifierName: string | null = null;

    if (t.isObjectPattern(contextParam)) {
        contextBindings = new Map();
        for (const prop of contextParam.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && t.isIdentifier(prop.value)) {
                contextBindings.set(prop.key.name, prop.value.name);
            }
        }
    } else if (t.isIdentifier(contextParam)) {
        contextIdentifierName = contextParam.name;
    } else {
        return method;
    }

    const convertibleCalls: ClassifiedCall[] = [];
    let hasUnconvertibleCall = false;

    traverse(method, {
        noScope: true,
        CallExpression(path) {
            const isCommitOrDispatchCall = matchesCommitOrDispatch(path.node.callee, contextBindings, contextIdentifierName);
            if (!isCommitOrDispatchCall) return;

            const classification = classifyCall(path.node);
            if (classification.kind === 'convertible') {
                convertibleCalls.push({ path, targetName: classification.targetName });
            } else {
                hasUnconvertibleCall = true;
            }
        },
    });

    if (hasUnconvertibleCall) {
        method.leadingComments = [
            ...(method.leadingComments ?? []),
            {
                type: 'CommentLine',
                value: ' TODO: contains a commit/dispatch call that could not be auto-converted (dynamic, cross-module, or root-scoped) — convert this whole action manually',
            } as t.CommentLine,
        ];
        return method;
    }

    for (const { path, targetName } of convertibleCalls) {
        const newCall = t.callExpression(t.memberExpression(t.thisExpression(), t.identifier(targetName)), path.node.arguments.slice(1));
        path.replaceWith(newCall);
    }

    method.params = method.params.slice(1);

    traverse(method, {
        noScope: true,
        MemberExpression(path) {
            if (!contextBindings) return;

            const stateName = contextBindings.get('state');
            const gettersName = contextBindings.get('getters');

            if (t.isIdentifier(path.node.object) && (path.node.object.name === stateName || path.node.object.name === gettersName)) {
                path.node.object = t.thisExpression();
            }
        },
    });

    return method;
}

function matchesCommitOrDispatch(
    callee: t.Expression | t.V8IntrinsicIdentifier,
    contextBindings: Map<string, string> | null,
    contextIdentifierName: string | null,
): boolean {
    if (contextBindings) {
        const commitName = contextBindings.get('commit');
        const dispatchName = contextBindings.get('dispatch');
        return t.isIdentifier(callee) && (callee.name === commitName || callee.name === dispatchName);
    }

    if (contextIdentifierName) {
        return (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object, { name: contextIdentifierName }) &&
            t.isIdentifier(callee.property) &&
            (callee.property.name === 'commit' || callee.property.name === 'dispatch')
        );
    }

    return false;
}

type CallClassification = { kind: 'convertible'; targetName: string } | { kind: 'unconvertible' };

function classifyCall(call: t.CallExpression): CallClassification {
    const target = call.arguments[0];

    if (!target || !t.isStringLiteral(target)) return { kind: 'unconvertible' };
    if (target.value.includes('/')) return { kind: 'unconvertible' };

    const optionsArg = call.arguments[2];
    const isRootScoped =
        optionsArg &&
        t.isObjectExpression(optionsArg) &&
        optionsArg.properties.some(
            (p) => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: 'root' }) && t.isBooleanLiteral(p.value, { value: true }),
        );
    if (isRootScoped) return { kind: 'unconvertible' };

    return { kind: 'convertible', targetName: target.value };
}