import { t, type NodePath } from '../../core/ast.js';
import type { Placer } from './rewriter.js';
import type { StoreRefs } from './store-refs.js';

function blockBody(fn: NodePath<t.Function> | null): t.BlockStatement | null {
    return fn && t.isBlockStatement(fn.node.body) ? fn.node.body : null;
}

function thisOwner(path: NodePath): NodePath<t.Function> | null {
    return path.findParent((p) => p.isFunction() && !p.isArrowFunctionExpression()) as NodePath<t.Function> | null;
}

export function placeInThisOwner(refs: StoreRefs): Placer {
    return (module, at) => {
        const block = blockBody(thisOwner(at)) ?? blockBody(at.getFunctionParent());
        return block ? refs.inBlock(module, block) : refs.inline(module);
    };
}

export function placeInInnermostFunction(refs: StoreRefs, piniaArgument?: t.Expression): Placer {
    return (module, at) => {
        const fn = at.getFunctionParent();
        if (!fn) return refs.inline(module, piniaArgument);
        const block = blockBody(fn);
        return block ? refs.inBlock(module, block) : refs.inline(module);
    };
}

export function placeInFunction(refs: StoreRefs, fn: NodePath<t.Function>): Placer {
    return (module) => {
        const block = blockBody(fn);
        return block ? refs.inBlock(module, block) : refs.inline(module);
    };
}
