import { t, type NodePath } from '../../core/ast.js';
import { ensureNamedImport, importSources } from '../../core/imports.js';
import type { PathResolver } from '../../core/path-resolver.js';
import type { ScriptUnit } from '../../core/project.js';
import type { ModuleInfo } from '../../core/store-model.js';

interface BlockGroup {
    placeholders: t.Identifier[];
    argument?: t.Expression;
}


export class StoreRefs {
    private names = new Map<ModuleInfo, string>();
    private used = new Set<ModuleInfo>();
    private blocks = new Map<t.BlockStatement, Map<ModuleInfo, BlockGroup>>();
    private declared = new Map<t.Node, Map<ModuleInfo, string>>();
    private topLevel = new Map<ModuleInfo, string>();
    private lastTopLevel: t.Statement | null = null;

    constructor(
        private unit: ScriptUnit,
        private resolver: PathResolver,
    ) {}

    nameFor(module: ModuleInfo): string {
        const existing = this.names.get(module);
        if (existing) return existing;

        const taken = (name: string): boolean =>
            this.unit.userNames.has(name) || [...this.names.values()].includes(name);

        let name = module.instanceName;
        if (taken(name)) {
            name = `${module.instanceName}Instance`;
            for (let i = 2; taken(name); i++) name = `${module.instanceName}Instance${i}`;
        }

        this.names.set(module, name);
        return name;
    }

    private call(module: ModuleInfo, argument?: t.Expression): t.CallExpression {
        this.used.add(module);
        return t.callExpression(t.identifier(module.exportName), argument ? [t.cloneNode(argument)] : []);
    }

    use(module: ModuleInfo): void {
        this.used.add(module);
    }

    inline(module: ModuleInfo, argument?: t.Expression): t.CallExpression {
        return this.call(module, argument);
    }

    inBlock(module: ModuleInfo, block: t.BlockStatement, argument?: t.Expression): t.Identifier {
        this.used.add(module);

        let groups = this.blocks.get(block);
        if (!groups) this.blocks.set(block, (groups = new Map()));
        let group = groups.get(module);
        if (!group) groups.set(module, (group = { placeholders: [], argument }));

        const placeholder = t.identifier(this.nameFor(module));
        group.placeholders.push(placeholder);
        return placeholder;
    }

    declareBefore(module: ModuleInfo, statement: NodePath<t.Statement>): t.Identifier {
        let stores = this.declared.get(statement.node);
        if (!stores) this.declared.set(statement.node, (stores = new Map()));

        let name = stores.get(module);
        if (!name) {
            name = this.topLevel.get(module) ?? this.nameFor(module);
            if (!this.topLevel.has(module)) {
                statement.insertBefore(this.declaration(module, name));
                if (statement.parentPath.isProgram()) this.topLevel.set(module, name);
            }
            stores.set(module, name);
        }

        return t.identifier(name);
    }

    ensureTopLevel(module: ModuleInfo): string {
        const existing = this.topLevel.get(module);
        if (existing) return existing;

        const name = this.nameFor(module);
        const body = this.unit.ast.program.body;
        // after the imports, and after the stores exposed before this one
        let index = this.lastTopLevel ? body.indexOf(this.lastTopLevel) + 1 : 0;
        if (index === 0) {
            body.forEach((node, i) => {
                if (t.isImportDeclaration(node)) index = i + 1;
            });
        }
        this.lastTopLevel = this.declaration(module, name);
        body.splice(index, 0, this.lastTopLevel);
        this.topLevel.set(module, name);
        return name;
    }

    private declaration(module: ModuleInfo, name: string, argument?: t.Expression): t.VariableDeclaration {
        return t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), this.call(module, argument))]);
    }

    finalize(): void {
        for (const [block, groups] of this.blocks) {
            const declarations: t.VariableDeclaration[] = [];

            for (const [module, group] of groups) {
                if (this.topLevel.has(module)) {
                    const name = this.topLevel.get(module)!;
                    for (const placeholder of group.placeholders) placeholder.name = name;
                    continue;
                }

                const [only] = group.placeholders;
                if (group.placeholders.length === 1 && only) {
                    const call = this.call(module, group.argument);
                    const node = only as unknown as Record<string, unknown>;
                    delete node.name;
                    Object.assign(node, call);
                    continue;
                }

                declarations.push(this.declaration(module, this.nameFor(module), group.argument));
            }

            block.body.unshift(...declarations);
        }
        this.blocks.clear();

        const preferredAliases = this.resolver.aliasPrefixesIn(importSources(this.unit));
        for (const module of this.used) {
            const target = module.def?.unit;
            if (!target || target === this.unit) continue;
            const specifier = this.resolver.toSpecifier(this.unit.file.path, target.file.path, preferredAliases);
            ensureNamedImport(this.unit, specifier, module.exportName);
        }
        this.used.clear();
    }
}
