import { getProgramPath, parseScript, printScript, staticKeyName, t, unwrapNode, type NodePath } from '../../core/ast.js';
import type { MigrationContext } from '../../core/context.js';
import type { FileUnit, ScriptUnit } from '../../core/project.js';
import type { ModuleInfo } from '../../core/store-model.js';
import { Rewriter } from '../shared/rewriter.js';

interface TemplateExpression {
    code: string;
    offset: number;
    /** `v-on` handlers may hold statements instead of a single expression. */
    allowStatements: boolean;
}

const ELEMENT = 1;
const INTERPOLATION = 5;
const DIRECTIVE = 7;

interface TemplateNode {
    type: number;
    loc: { source: string; start: { offset: number } };
    children?: TemplateNode[];
    props?: TemplateNode[];
    content?: TemplateNode;
    exp?: TemplateNode;
    name?: string;
}

function storePattern(names: Iterable<string>): RegExp {
    const alternatives = ['\\$store', ...[...names].map((name) => name.replace(/[$]/g, '\\$&'))];
    return new RegExp(`(?<![\\w$.])(?:${alternatives.join('|')})(?![\\w$])`);
}

export function convertTemplate(ctx: MigrationContext, file: FileUnit): void {
    const template = file.descriptor?.template;
    const storeNames = new Set(['$store', ...file.templateStoreNames]);
    const usesStore = storePattern(file.templateStoreNames);
    if (!template || !usesStore.test(template.content)) return;

    const ast = template.ast as unknown as TemplateNode | undefined;
    if (!ast || (template.lang && template.lang !== 'html')) {
        ctx.report.todo(file.path, `the <template> uses $store but is written in "${template.lang ?? 'an unsupported format'}" — migrate it manually`);
        return;
    }

    const exposer = createExposer(ctx, file);
    if (!exposer) {
        ctx.report.todo(file.path, 'the <template> uses $store, but the component has no <script setup> or options object to expose a Pinia store from — migrate it manually');
        return;
    }

    const expressions: TemplateExpression[] = [];
    collectExpressions(ast, expressions);

    const useTypeScript = file.scripts.some((unit) => unit.lang === 'ts' || unit.lang === 'tsx');

    for (const expression of expressions) {
        if (!usesStore.test(expression.code)) continue;
        if (file.source.slice(expression.offset, expression.offset + expression.code.length) !== expression.code) continue;

        const line = file.source.slice(0, expression.offset).split('\n').length;
        const rewritten = rewriteExpression(ctx, exposer.unit, expression, useTypeScript, line, exposer.expose, storeNames);

        if (rewritten === null) {
            ctx.report.todo(file.path, 'a template expression using $store could not be parsed — migrate it manually', line);
        } else if (rewritten !== expression.code) {
            file.templateEdits.push({ start: expression.offset, end: expression.offset + expression.code.length, text: rewritten });
        }
    }
}

function collectExpressions(node: TemplateNode, out: TemplateExpression[]): void {
    if (node.type === INTERPOLATION && node.content) {
        out.push({ code: node.content.loc.source, offset: node.content.loc.start.offset, allowStatements: false });
    }

    if (node.type === ELEMENT) {
        for (const prop of node.props ?? []) {
            if (prop.type !== DIRECTIVE || !prop.exp || prop.name === 'slot') continue;
            const code = prop.exp.loc.source;
            const offset = prop.exp.loc.start.offset;

            if (prop.name === 'for') {
                const match = /^([\s\S]*?\s(?:in|of)\s+)([\s\S]*)$/.exec(code);
                if (match?.[1] !== undefined && match[2] !== undefined) {
                    out.push({ code: match[2], offset: offset + match[1].length, allowStatements: false });
                }
                continue;
            }

            out.push({ code, offset, allowStatements: prop.name === 'on' });
        }
    }

    for (const child of node.children ?? []) collectExpressions(child, out);
}

function rewriteExpression(
    ctx: MigrationContext,
    unit: ScriptUnit,
    expression: TemplateExpression,
    useTypeScript: boolean,
    line: number,
    expose: (module: ModuleInfo) => string,
    storeNames: Set<string>,
): string | null {
    const lang = useTypeScript ? 'ts' : 'js';
    const leading = /^\s*/.exec(expression.code)?.[0] ?? '';
    const trailing = /\s*$/.exec(expression.code)?.[0] ?? '';
    const code = expression.code.trim();

    let ast: t.File | null = null;
    let wrapped = true;
    try {
        ast = parseScript(`(${code})`, lang);
    } catch {
        if (!expression.allowStatements) return null;
        try {
            ast = parseScript(code, lang);
            wrapped = false;
        } catch {
            return null;
        }
    }

    const program = getProgramPath(ast, false);
    const references: NodePath[] = [];
    program.traverse({
        Identifier(path) {
            if (storeNames.has(path.node.name) && path.isReferencedIdentifier() && !path.scope.hasBinding(path.node.name)) references.push(path);
        },
    });
    if (references.length === 0) return expression.code;

    const rewriter = new Rewriter(ctx, unit, (module) => t.identifier(expose(module)), { noComments: true, fixedLine: line });
    for (const reference of references) rewriter.rewriteStore(reference);
    rewriter.flush();

    let printed = printScript(ast, { ...unit.style, quote: 'single' }).trim();
    if (wrapped) {
        printed = printed.replace(/;$/, '').trim();
        if (!printed.startsWith('(') || !printed.endsWith(')')) return null;
        printed = printed.slice(1, -1);
    }
    if (printed.includes('"') && !code.includes('"')) return null;

    return leading + printed.trim() + trailing;
}

interface Exposer {
    unit: ScriptUnit;
    expose(module: ModuleInfo): string;
}

function createExposer(ctx: MigrationContext, file: FileUnit): Exposer | null {
    const descriptor = file.descriptor;
    if (file.scripts.length === 0 && descriptor && !descriptor.script && !descriptor.scriptSetup) {
        ctx.project.addScriptSetup(file);
        if (ctx.model.vueVersion === 2) {
            ctx.report.info(file.path, 'a <script setup> block was added to expose the Pinia stores to the template — this needs Vue 2.7 or newer');
        }
    }

    const setupUnit = file.scripts.find((unit) => unit.kind === 'scriptSetup');
    if (setupUnit) {
        const refs = ctx.refs(setupUnit);
        return { unit: setupUnit, expose: (module) => refs.ensureTopLevel(module) };
    }

    const scriptUnit = file.scripts.find((unit) => unit.kind === 'script');
    const options = scriptUnit ? findComponentOptions(scriptUnit) : null;
    if (!scriptUnit || !options) return null;

    const refs = ctx.refs(scriptUnit);
    const exposed = new Map<ModuleInfo, string>();

    return {
        unit: scriptUnit,
        expose(module) {
            let name = exposed.get(module);
            if (!name) {
                name = refs.nameFor(module);
                const getter = t.objectMethod('method', t.identifier(name), [], t.blockStatement([t.returnStatement(refs.inline(module))]));
                addComputed(options, getter);
                exposed.set(module, name);
            }
            return name;
        },
    };
}

/** The options object of an Options API component: `export default {...}`, `defineComponent({...})`, `Vue.extend({...})`. */
export function findComponentOptions(unit: ScriptUnit): t.ObjectExpression | null {
    const body = unit.ast.program.body;
    const exported = body.find((node): node is t.ExportDefaultDeclaration => t.isExportDefaultDeclaration(node));
    if (!exported) return null;

    const resolve = (node: t.Node, depth = 0): t.ObjectExpression | null => {
        const value = unwrapNode(node);
        if (t.isObjectExpression(value)) return value;
        if (t.isCallExpression(value)) {
            const [first] = value.arguments;
            return first ? resolve(first, depth + 1) : null;
        }
        if (t.isIdentifier(value) && depth < 3) {
            for (const statement of body) {
                if (!t.isVariableDeclaration(statement)) continue;
                for (const declarator of statement.declarations) {
                    if (t.isIdentifier(declarator.id, { name: value.name }) && declarator.init) return resolve(declarator.init, depth + 1);
                }
            }
        }
        return null;
    };

    return resolve(exported.declaration);
}

const KEYS_AFTER_COMPUTED = new Set([
    'watch',
    'methods',
    'beforeCreate',
    'created',
    'beforeMount',
    'mounted',
    'beforeUpdate',
    'updated',
    'beforeUnmount',
    'unmounted',
    'beforeDestroy',
    'destroyed',
    'activated',
    'deactivated',
]);

function addComputed(options: t.ObjectExpression, getter: t.ObjectMethod): void {
    const keyOf = (property: t.ObjectExpression['properties'][number]): string | null =>
        t.isSpreadElement(property) ? null : staticKeyName(property.key, property.computed);

    const computed = options.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && keyOf(p) === 'computed');

    if (computed) {
        const value = unwrapNode(computed.value);
        if (t.isObjectExpression(value)) value.properties.push(getter);
        else computed.value = t.objectExpression([t.spreadElement(computed.value as t.Expression), getter]);
        return;
    }

    const property = t.objectProperty(t.identifier('computed'), t.objectExpression([getter]));
    const index = options.properties.findIndex((p) => KEYS_AFTER_COMPUTED.has(keyOf(p) ?? ''));
    if (index === -1) options.properties.push(property);
    else options.properties.splice(index, 0, property);
}
