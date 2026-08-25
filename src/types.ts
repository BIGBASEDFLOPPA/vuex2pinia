import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

export interface TransformContext {
    filePath: string;
    warnings: string[];
}

export interface Transform {
    name: string;
    detect(ast: t.File): boolean;
    apply(ast: t.File, ctx: TransformContext): boolean;
}