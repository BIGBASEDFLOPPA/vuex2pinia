import { parse } from '@babel/parser';
import { traverse, generateCode } from './babel-interop.js';
import prettier from 'prettier';
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
    /** The original file content, but run through prettier first so the
     *  diff against transformedSource only shows real transform changes,
     *  not pre-existing formatting differences. */
    originalSource: string;
    transformedSource: string;
    changed: boolean;
}

export async function runStoreTransforms(
    filePath: string,
    originalSource: string,
    registry: StoreTransformRegistry,
    options: RunStoreTransformsOptions = {},
): Promise<StoreTransformResult> {
    const ast = parse(originalSource, { sourceType: 'module', plugins: ['typescript'] });

    for (const [name, transform] of Object.entries(registry.storeTransforms)) {
        if (options.only && !options.only.includes(name)) continue;
        transform(ast);
    }

    const generated = generateCode(ast);
    const transformedSource = await formatWithPrettier(generated, filePath);
    const normalizedOriginal = await formatWithPrettier(originalSource, filePath);

    return {
        filePath,
        originalSource: normalizedOriginal,
        transformedSource,
        changed: transformedSource !== normalizedOriginal,
    };
}

async function formatWithPrettier(code: string, filePath: string): Promise<string> {
    return prettier.format(code, { filepath: filePath, parser: 'typescript' });
}

export { traverse };