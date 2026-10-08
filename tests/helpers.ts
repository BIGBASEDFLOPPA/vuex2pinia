import { resolve, sep } from 'node:path';
import { memoryFileSystem, migrate, type MigrateOptions, type MigrateResult, type ReportMessage } from '../src/index.js';

export interface Migration {
    result: MigrateResult;
    /** Transformed content of a file (path as given in the fixture). */
    output(path: string): string;
    changed(path: string): boolean;
    messages(level?: ReportMessage['level']): string[];
}

const ROOT = '/project';

/**
 * Runs the migration over an in-memory project. Paths are relative to the
 * project root; `src/store/index.js` (or `.ts`) is the store unless told otherwise.
 */
export function runMigration(files: Record<string, string>, options: Partial<MigrateOptions> = {}): Migration {
    const absolute: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) absolute[`${ROOT}/${path}`] = content;
    if (!('package.json' in files)) {
        absolute[`${ROOT}/package.json`] = JSON.stringify({ dependencies: { vue: '^3.4.0', vuex: '^4.1.0' } });
    }

    const storePath =
        options.storePath ?? (Object.keys(files).find((path) => /^src\/store\/index\.[jt]s$/.test(path)) ?? 'src/store/index.js');

    const result = migrate({
        ...options,
        storePath: `${ROOT}/${storePath}`,
        files: Object.keys(absolute).filter((path) => /\.(vue|[jt]sx?)$/.test(path)),
        fs: memoryFileSystem(absolute),
    });

    const find = (path: string) => {
        const file = result.files.find((f) => f.path === resolve(`${ROOT}/${path}`));
        if (!file) throw new Error(`file was not part of the migration: ${path}`);
        return file;
    };

    return {
        result,
        output: (path) => find(path).transformedSource,
        changed: (path) => find(path).changed,
        messages: (level) =>
            result.messages
                .filter((m) => !level || m.level === level)
                .map((m) => `${m.file.replace(resolve(ROOT), '').split(sep).join('/')}: ${m.message}`),
    };
}

/** Strips the common indentation of a template literal so fixtures can be indented with the test. */
export function code(strings: TemplateStringsArray, ...values: unknown[]): string {
    const text = String.raw({ raw: strings }, ...values).replace(/^\n/, '');
    const indents = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => /^ */.exec(line)![0].length);
    const indent = Math.min(...indents);
    return text
        .split('\n')
        .map((line) => line.slice(indent))
        .join('\n')
        .replace(/\s+$/, '\n');
}
