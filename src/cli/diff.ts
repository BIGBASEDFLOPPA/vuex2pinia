import { structuredPatch } from 'diff';
import pc from 'picocolors';

/** Renders a unified diff (changed hunks with a few lines of context). */
export function renderDiff(originalSource: string, transformedSource: string): string {
    const patch = structuredPatch('', '', originalSource, transformedSource, '', '', { context: 3 });
    const lines: string[] = [];

    for (const hunk of patch.hunks) {
        lines.push(pc.cyan(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));

        for (const line of hunk.lines) {
            const text = line.replace(/\r$/, '');
            if (text.startsWith('+')) lines.push(pc.green(text));
            else if (text.startsWith('-')) lines.push(pc.red(text));
            else if (text.startsWith('\\')) continue;
            else lines.push(pc.dim(text));
        }
    }

    return lines.join('\n');
}
