import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import type { Node } from '@babel/types';

type TraverseFn = typeof traverseModule;
type GenerateFn = typeof generateModule;

export const traverse: TraverseFn =
    (traverseModule as unknown as { default?: TraverseFn }).default ?? traverseModule;

const generateRaw: GenerateFn =
    (generateModule as unknown as { default?: GenerateFn }).default ?? generateModule;

export function generateCode(ast: Node): string {
    return generateRaw(ast, { jsescOption: { quotes: 'single' } }).code;
}