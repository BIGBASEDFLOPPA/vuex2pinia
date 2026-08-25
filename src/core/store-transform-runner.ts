import { parse } from '@babel/parser';
import { traverse, generateCode } from './babel-interop.js';
import type { File } from '@babel/types';

export type StoreTransform = (ast: File) => void;

export interface StoreTransformRegistry {
    storeTransforms: Record<string, StoreTransform>;
}

export interface RunStoreTransformsOptions {
    only?: string[];
}

export interface StoreTransformResult {
    filePath: string;
    originalSource: string;
    transformedSource: string;
    changed: boolean;
}

export function runStoreTransforms(
    filePath: string,
    originalSource: string,
    registry: StoreTransformRegistry,
    options: RunStoreTransformsOptions = {},
): StoreTransformResult {
    const ast = parse(originalSource, { sourceType: 'module', plugins: ['typescript'] });

    for (const [name, transform] of Object.entries(registry.storeTransforms)) {
        if (options.only && !options.only.includes(name)) continue;
        transform(ast);
    }

    const transformedSource = generateCode(ast);

    return {
        filePath,
        originalSource,
        transformedSource,
        changed: transformedSource !== originalSource,
    };
}

export { traverse };