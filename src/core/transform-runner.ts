import { parseSFCSource, type ParsedSFC } from './sfc-parser.js';

export type ScriptTransform = (scriptCode: string) => string;
export type TemplateTransform = (templateMarkup: string) => string;

export interface TransformRegistry {
    scriptTransforms: Record<string, ScriptTransform>;
    templateTransforms: Record<string, TemplateTransform>;
}

export interface RunTransformsOptions {
    only?: string[];
}

export interface TransformResult {
    filePath: string;
    originalSource: string;
    transformedSource: string;
    changed: boolean;
}

export function runTransforms(
    filePath: string,
    originalSource: string,
    registry: TransformRegistry,
    options: RunTransformsOptions = {},
): TransformResult {
    const parsed = parseSFCSource(filePath, originalSource);

    const scriptBlock = parsed.descriptor.scriptSetup ?? parsed.descriptor.script;
    const newScriptCode = scriptBlock
        ? applyTransforms(scriptBlock.content, registry.scriptTransforms, options.only)
        : null;

    const templateBlock = parsed.descriptor.template;
    const newTemplateMarkup = templateBlock
        ? applyTransforms(templateBlock.content, registry.templateTransforms, options.only)
        : null;

    const transformedSource = rebuildSource(originalSource, {
        scriptBlock,
        newScriptCode,
        templateBlock,
        newTemplateMarkup,
    });

    return {
        filePath,
        originalSource,
        transformedSource,
        changed: transformedSource !== originalSource,
    };
}

function applyTransforms<T extends ScriptTransform | TemplateTransform>(
    content: string,
    transforms: Record<string, T>,
    only?: string[],
): string {
    let result = content;
    for (const [name, transform] of Object.entries(transforms)) {
        if (only && !only.includes(name)) continue;
        result = transform(result);
    }
    return result;
}

function rebuildSource(
    originalSource: string,
    blocks: {
        scriptBlock: ParsedSFC['descriptor']['script'];
        newScriptCode: string | null;
        templateBlock: ParsedSFC['descriptor']['template'];
        newTemplateMarkup: string | null;
    },
): string {
    const edits: { start: number; end: number; replacement: string }[] = [];

    if (blocks.scriptBlock && blocks.newScriptCode !== null) {
        edits.push({
            start: blocks.scriptBlock.loc.start.offset,
            end: blocks.scriptBlock.loc.end.offset,
            replacement: blocks.newScriptCode,
        });
    }

    if (blocks.templateBlock && blocks.newTemplateMarkup !== null) {
        edits.push({
            start: blocks.templateBlock.loc.start.offset,
            end: blocks.templateBlock.loc.end.offset,
            replacement: blocks.newTemplateMarkup,
        });
    }

    edits.sort((a, b) => b.start - a.start);

    let result = originalSource;
    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }

    return result;
}