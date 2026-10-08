import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse as parseSFC, type SFCDescriptor } from '@vue/compiler-sfc';
import {
    detectStyle,
    getProgramPath,
    langFromAttr,
    langFromPath,
    parseScript,
    printScript,
    t,
    type CodeStyle,
    type NodePath,
    type ScriptLang,
} from './ast.js';
import { collectUsedNames } from './imports.js';

export interface DirectoryEntry {
    name: string;
    isDirectory: boolean;
}

export interface FileSystem {
    readFile(path: string): string | undefined;
    isFile(path: string): boolean;
    /** Entries of a directory, or undefined when the path is not a directory. */
    readDir(path: string): DirectoryEntry[] | undefined;
}

export const nodeFileSystem: FileSystem = {
    readFile(path) {
        try {
            return readFileSync(path, 'utf-8');
        } catch {
            return undefined;
        }
    },
    isFile(path) {
        try {
            return statSync(path).isFile();
        } catch {
            return false;
        }
    },
    readDir(path) {
        try {
            return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
        } catch {
            return undefined;
        }
    },
};

/** In-memory file system, handy for tests and programmatic use. */
export function memoryFileSystem(files: Record<string, string>): FileSystem {
    const map = new Map(Object.entries(files).map(([path, content]) => [resolve(path), content]));
    return {
        readFile: (path) => map.get(resolve(path)),
        isFile: (path) => map.has(resolve(path)),
        readDir(path) {
            const dir = resolve(path);
            const entries = new Map<string, DirectoryEntry>();
            for (const file of map.keys()) {
                const rel = relative(dir, file);
                if (rel === '' || rel.startsWith('..') || resolve(dir, rel) !== file) continue;
                const [name] = rel.split(sep);
                if (name) entries.set(name, { name, isDirectory: dirname(file) !== dir });
            }
            return entries.size > 0 ? [...entries.values()] : undefined;
        },
    };
}

/** An import statement directly followed by a line of code (no blank line in between). */
const IMPORT_GLUED_TO_CODE = /^(?:import\b[^\n]*|\} from [^\n]*)\r?\n(?=(?!import\b|\} from )[^\s/])/m;

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

export interface ScriptUnit {
    file: FileUnit;
    kind: 'module' | 'script' | 'scriptSetup';
    lang: ScriptLang;
    /** Source of this script (the whole file, or the content of an SFC block). */
    source: string;
    /** Offsets of `source` inside the file. */
    start: number;
    end: number;
    ast: t.File;
    program: NodePath<t.Program>;
    style: CodeStyle;
    /** Import bindings that were in use before any transform ran. */
    initiallyUsed: Set<string>;
    /** Every identifier name that appears in the script (used to avoid name clashes). */
    userNames: Set<string>;
    /** Top-level statements that were swapped for a generated one (old node -> new node). */
    replaced: Map<t.Node, t.Node>;
    /** True for a `<script setup>` block the migration had to add to a template-only component. */
    synthetic?: boolean;
}

export interface FileUnit {
    path: string;
    source: string;
    scripts: ScriptUnit[];
    descriptor?: SFCDescriptor;
    templateEdits: TextEdit[];
    /** `<script setup>` variables that held the Vuex store and may still be used by the template. */
    templateStoreNames: Set<string>;
    error?: string;
}

export class Project {
    private files = new Map<string, FileUnit>();

    constructor(public fs: FileSystem) {}

    load(filePath: string): FileUnit | null {
        const path = resolve(filePath);
        const cached = this.files.get(path);
        if (cached) return cached;

        const source = this.fs.readFile(path);
        if (source === undefined) return null;

        const file: FileUnit = { path, source, scripts: [], templateEdits: [], templateStoreNames: new Set() };
        this.files.set(path, file);

        try {
            if (/\.vue$/i.test(path)) this.loadSFC(file);
            else file.scripts.push(this.createUnit(file, 'module', langFromPath(path), source, 0, source.length));
        } catch (error) {
            file.scripts = [];
            file.error = error instanceof Error ? error.message : String(error);
        }

        return file;
    }

    /** The script of a plain JS/TS module (null for SFCs and unparsable files). */
    moduleUnit(filePath: string): ScriptUnit | null {
        const file = this.load(filePath);
        const unit = file?.scripts[0];
        return unit && unit.kind === 'module' ? unit : null;
    }

    loaded(): FileUnit[] {
        return [...this.files.values()];
    }

    refresh(unit: ScriptUnit): void {
        unit.program = getProgramPath(unit.ast);
    }

    render(file: FileUnit): string {
        const edits: TextEdit[] = [...file.templateEdits];

        for (const unit of file.scripts) {
            // files without any indentation of their own follow the rest of the project
            if (!unit.style.indentDetected || !unit.style.multilineDetected) {
                const reference = this.referenceStyle();
                if (reference) unit.style = detectStyle(unit.kind === 'module' ? unit.source : file.source, reference);
            }
            let printed = printScript(unit.ast, unit.style, unit.source);
            if (printed === unit.source) continue;
            // recast glues generated imports to the code below them
            if (!IMPORT_GLUED_TO_CODE.test(unit.source)) {
                printed = printed.replace(IMPORT_GLUED_TO_CODE, (match) => match + unit.style.lineTerminator);
            }
            const eol = unit.style.lineTerminator;
            const text = unit.synthetic ? `<script setup>${eol}${printed.trim()}${eol}</script>${eol}${eol}` : printed;
            edits.push({ start: unit.start, end: unit.end, text });
        }

        edits.sort((a, b) => b.start - a.start);

        let result = file.source;
        for (const edit of edits) {
            result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
        }
        return result;
    }

    /** Style of the first file that shows how the project is formatted. */
    private referenceStyle(): CodeStyle | null {
        for (const file of this.files.values()) {
            const style = file.scripts.find((unit) => unit.style.indentDetected && unit.style.multilineDetected)?.style;
            if (style) return style;
        }
        return null;
    }

    /** Adds an empty `<script setup>` block (rendered only if something ends up in it). */
    addScriptSetup(file: FileUnit): ScriptUnit {
        const unit = this.createUnit(file, 'scriptSetup', 'js', '', 0, 0);
        unit.synthetic = true;
        file.scripts.push(unit);
        return unit;
    }

    private loadSFC(file: FileUnit): void {
        const { descriptor, errors } = parseSFC(file.source, { filename: file.path, sourceMap: false });
        if (errors.length > 0) throw new Error(errors.map(String).join('; '));

        file.descriptor = descriptor;

        const blocks = [
            { block: descriptor.script, kind: 'script' as const },
            { block: descriptor.scriptSetup, kind: 'scriptSetup' as const },
        ];

        for (const { block, kind } of blocks) {
            if (!block || block.src) continue;
            file.scripts.push(
                this.createUnit(file, kind, langFromAttr(block.lang), block.content, block.loc.start.offset, block.loc.end.offset),
            );
        }
    }

    private createUnit(
        file: FileUnit,
        kind: ScriptUnit['kind'],
        lang: ScriptLang,
        source: string,
        start: number,
        end: number,
    ): ScriptUnit {
        const ast = parseScript(source, lang);

        const userNames = new Set<string>();
        t.traverseFast(ast, (node) => {
            if (t.isIdentifier(node) || t.isJSXIdentifier(node)) userNames.add(node.name);
        });

        return {
            file,
            kind,
            lang,
            source,
            start,
            end,
            ast,
            // no cache reset here: paths of files loaded earlier must stay consistent while the store is analysed
            program: getProgramPath(ast, false),
            style: detectStyle(kind === 'module' ? source : file.source),
            initiallyUsed: collectUsedNames(ast),
            userNames,
            replaced: new Map(),
        };
    }
}
