import * as recast from 'recast';
import { parse as babelParse, type ParserPlugin } from '@babel/parser';
import generateModule from '@babel/generator';
import traverseModule, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

type TraverseFn = typeof traverseModule;

export const traverse: TraverseFn =
    (traverseModule as unknown as { default?: TraverseFn }).default ?? traverseModule;

type GenerateFn = typeof generateModule;

const generate: GenerateFn = (generateModule as unknown as { default?: GenerateFn }).default ?? generateModule;

export type ScriptLang = 'js' | 'jsx' | 'ts' | 'tsx';

export interface CodeStyle {
    quote: 'single' | 'double';
    tabWidth: number;
    useTabs: boolean;
    lineTerminator: string;
    trailingComma: boolean;
    arrowParensAlways: boolean;
    wrapColumn: number;
    /** False when the source gave no hint about indentation / trailing commas (e.g. a file of one-liners). */
    indentDetected: boolean;
    multilineDetected: boolean;
}

export const TODO_PREFIX = 'TODO(vuex2pinia)';

export function langFromPath(filePath: string): ScriptLang {
    if (/\.tsx$/i.test(filePath)) return 'tsx';
    if (/\.[cm]?ts$/i.test(filePath)) return 'ts';
    if (/\.jsx$/i.test(filePath)) return 'jsx';
    return 'js';
}

export function langFromAttr(lang: string | undefined | null): ScriptLang {
    if (lang === 'ts') return 'ts';
    if (lang === 'tsx') return 'tsx';
    if (lang === 'jsx') return 'jsx';
    return 'js';
}

function pluginsFor(lang: ScriptLang): ParserPlugin[] {
    const plugins: ParserPlugin[] = ['decorators-legacy'];
    if (lang === 'ts' || lang === 'tsx') plugins.push('typescript');
    if (lang !== 'ts') plugins.push('jsx');
    return plugins;
}

function babelParseWith(source: string, plugins: ParserPlugin[]) {
    return babelParse(source, {
        sourceType: 'module',
        plugins,
        tokens: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
    });
}

/** Parses with recast so untouched code keeps its original formatting on print. */
export function parseScript(source: string, lang: ScriptLang): t.File {
    return recast.parse(source, {
        parser: {
            parse(code: string) {
                try {
                    return babelParseWith(code, pluginsFor(lang));
                } catch (error) {
                    // plain .js files sometimes contain TypeScript-only or JSX-hostile syntax
                    if (lang !== 'js') throw error;
                    try {
                        return babelParseWith(code, ['decorators-legacy', 'typescript']);
                    } catch {
                        throw error;
                    }
                }
            },
        },
    }) as t.File;
}

/**
 * Prints the AST; `originalSource` lets tab-indented files get tabs on the
 * lines recast generated (it only emits spaces for those).
 */
export function printScript(ast: t.Node, style: CodeStyle, originalSource?: string): string {
    const code = recast.print(ast, {
        quote: style.quote,
        tabWidth: style.tabWidth,
        useTabs: style.useTabs,
        lineTerminator: style.lineTerminator,
        trailingComma: style.trailingComma,
        arrowParensAlways: style.arrowParensAlways,
        wrapColumn: style.wrapColumn,
    }).code;

    if (!style.useTabs || originalSource === undefined || code === originalSource) return code;

    const originalLines = new Set(originalSource.split(/\r?\n/));
    return code
        .split(style.lineTerminator)
        .map((line) => {
            const indent = /^[ \t]*/.exec(line)![0];
            if (!indent.includes(' ') || originalLines.has(line)) return line;
            let columns = 0;
            for (const char of indent) columns += char === '\t' ? style.tabWidth : 1;
            return '\t'.repeat(Math.floor(columns / style.tabWidth)) + ' '.repeat(columns % style.tabWidth) + line.slice(indent.length);
        })
        .join(style.lineTerminator);
}

export function detectStyle(source: string, fallback?: CodeStyle): CodeStyle {
    const lineTerminator = source.includes('\r\n') ? '\r\n' : '\n';

    let useTabs = fallback?.useTabs ?? false;
    let tabWidth = fallback?.tabWidth ?? 4;
    const indentMatch = /^(\t+|[ ]{2,})\S/m.exec(source);
    if (indentMatch?.[1]) {
        useTabs = indentMatch[1].startsWith('\t');
        tabWidth = useTabs || indentMatch[1].length > 4 ? 4 : indentMatch[1].length;
    }

    const singles = (source.match(/'/g) ?? []).length;
    const doubles = (source.match(/"/g) ?? []).length;

    // `a: 1,\n}` proves trailing commas, `a: 1\n}` disproves them, anything else says nothing
    const hasTrailingComma = /,[ \t]*\r?\n\s*[}\]]/.test(source);
    const lacksTrailingComma = /[\w'"`)][ \t]*\r?\n\s*[}\]]/.test(source);
    const multilineDetected = hasTrailingComma || lacksTrailingComma;
    const trailingComma = multilineDetected ? hasTrailingComma : (fallback?.trailingComma ?? false);

    const arrowParensAlways = /\(\s*[A-Za-z_$][\w$]*\s*\)\s*=>/.test(source);

    // never re-wrap code more aggressively than the file itself does
    const longestLine = source.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
    const wrapColumn = Math.min(Math.max(longestLine, 100), 240);

    return {
        quote: singles === doubles && fallback ? fallback.quote : doubles > singles ? 'double' : 'single',
        tabWidth,
        useTabs,
        lineTerminator,
        trailingComma,
        arrowParensAlways,
        wrapColumn,
        indentDetected: !!indentMatch,
        multilineDetected,
    };
}

/** Returns a freshly crawled program path (scope info is rebuilt from scratch). */
export function getProgramPath(ast: t.File, clearCache = true): NodePath<t.Program> {
    if (clearCache) traverse.cache.clear();
    let program: NodePath<t.Program> | undefined;
    traverse(ast, {
        Program(path) {
            program = path;
            path.stop();
        },
    });
    if (!program) throw new Error('Program node not found');
    return program;
}

/**
 * recast prints every new object literal / pattern one property per line.
 * For small generated nodes that is noise, so they are rendered on one line
 * and parsed back: recast then keeps that formatting.
 */
function compact<T extends t.Node>(node: T, wrap: (code: string) => string, pick: (file: t.File) => t.Node | null | undefined): T {
    try {
        const code = generate(node, { concise: true, jsescOption: { quotes: 'single' } }).code;
        return (pick(parseScript(wrap(code), 'ts')) as T | null | undefined) ?? node;
    } catch {
        return node;
    }
}

export function compactPattern(pattern: t.ObjectPattern): t.ObjectPattern {
    return compact(
        pattern,
        (code) => `const ${code} = x;`,
        (file) => {
            const [statement] = file.program.body;
            return t.isVariableDeclaration(statement) ? statement.declarations[0]?.id : null;
        },
    );
}

export function compactExpression<T extends t.Expression>(expression: T): T {
    return compact(
        expression,
        (code) => `x = ${code};`,
        (file) => {
            const [statement] = file.program.body;
            return t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression) ? statement.expression.right : null;
        },
    );
}

type RecastComment = t.Comment & { leading?: boolean; trailing?: boolean };
type WithComments = t.Node & { comments?: RecastComment[] | null };

export function addLeadingComment(node: t.Node, text: string): void {
    const target = node as WithComments;
    const value = ` ${text}`;
    const existing = target.comments ?? [];
    if (existing.some((c) => c.value === value)) return;
    target.comments = [...existing, { type: 'CommentLine', value, leading: true, trailing: false } as RecastComment];
}

export function moveComments(from: t.Node, to: t.Node): void {
    const source = from as WithComments;
    if (!source.comments?.length) return;
    const target = to as WithComments;
    target.comments = [...source.comments, ...(target.comments ?? [])];
    source.comments = null;
}

/** The node a TODO comment can be attached to without landing in the middle of an expression. */
export function commentAnchor(path: NodePath): t.Node {
    const anchor = path.find(
        (p) =>
            p.isStatement() ||
            p.isClassMethod() ||
            p.isClassProperty() ||
            ((p.isObjectProperty() || p.isObjectMethod() || p.isSpreadElement()) &&
                (p.parentPath?.isObjectExpression() ?? false)),
    );
    return (anchor ?? path).node;
}

export function unwrapNode<T extends t.Node>(node: T): t.Node {
    let current: t.Node = node;
    while (
        t.isTSAsExpression(current) ||
        t.isTSSatisfiesExpression(current) ||
        t.isTSNonNullExpression(current) ||
        t.isTSTypeAssertion(current) ||
        t.isParenthesizedExpression(current) ||
        t.isTypeCastExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

export function unwrapPath(path: NodePath): NodePath {
    let current = path;
    while (
        current.isTSAsExpression() ||
        current.isTSSatisfiesExpression() ||
        current.isTSNonNullExpression() ||
        current.isTSTypeAssertion() ||
        current.isParenthesizedExpression() ||
        current.isTypeCastExpression()
    ) {
        current = current.get('expression') as NodePath;
    }
    return current;
}

export function isValidIdentifier(name: string): boolean {
    return t.isValidIdentifier(name, false);
}

export function memberAccess(object: t.Expression, name: string): t.MemberExpression {
    return isValidIdentifier(name)
        ? t.memberExpression(object, t.identifier(name))
        : t.memberExpression(object, t.stringLiteral(name), true);
}

export function objectKey(name: string): t.Identifier | t.StringLiteral {
    return isValidIdentifier(name) ? t.identifier(name) : t.stringLiteral(name);
}

/** Static name of a non-computed (or string-literal) member / property key, if any. */
export function staticKeyName(node: t.Node, computed: boolean): string | null {
    if (!computed && t.isIdentifier(node)) return node.name;
    if (t.isStringLiteral(node)) return node.value;
    if (t.isNumericLiteral(node)) return String(node.value);
    if (computed && t.isTemplateLiteral(node) && node.expressions.length === 0) {
        return node.quasis[0]?.value.cooked ?? null;
    }
    return null;
}

export function isMemberLike(node: t.Node | null | undefined): node is t.MemberExpression | t.OptionalMemberExpression {
    return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

export function isCallLike(node: t.Node | null | undefined): node is t.CallExpression | t.OptionalCallExpression {
    return t.isCallExpression(node) || t.isOptionalCallExpression(node);
}

export function isFunctionNode(
    node: t.Node | null | undefined,
): node is t.FunctionExpression | t.ArrowFunctionExpression | t.FunctionDeclaration | t.ObjectMethod {
    return (
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isFunctionDeclaration(node) ||
        t.isObjectMethod(node)
    );
}

export function lineOf(node: t.Node | null | undefined): number | undefined {
    return node?.loc?.start.line;
}

export { t };
export type { NodePath };
