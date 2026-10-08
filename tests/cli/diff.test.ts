import { describe, expect, it } from 'vitest';
import { renderDiff } from '../../src/cli/diff.js';

// colours depend on the terminal; the tests only care about the text
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const lines = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe('renderDiff', () => {
    it('returns an empty string for identical sources', () => {
        expect(renderDiff('a\nb\n', 'a\nb\n')).toBe('');
    });

    it('renders a hunk with removed and added lines', () => {
        const output = plain(renderDiff(`import { mapState } from 'vuex';\n`, `import { mapState } from 'pinia';\n`));

        expect(output.split('\n')).toEqual([
            '@@ -1,1 +1,1 @@',
            `-import { mapState } from 'vuex';`,
            `+import { mapState } from 'pinia';`,
        ]);
    });

    it('shows three lines of context around a change', () => {
        const before = lines(10);
        const after = [...before];
        after[4] = 'changed';

        expect(plain(renderDiff(before.join('\n') + '\n', after.join('\n') + '\n')).split('\n')).toEqual([
            '@@ -2,7 +2,7 @@',
            ' line 2',
            ' line 3',
            ' line 4',
            '-line 5',
            '+changed',
            ' line 6',
            ' line 7',
            ' line 8',
        ]);
    });

    it('splits distant changes into separate hunks', () => {
        const before = lines(30);
        const after = [...before];
        after[1] = 'first';
        after[27] = 'second';

        const output = plain(renderDiff(before.join('\n'), after.join('\n')));
        expect(output.match(/^@@ /gm)).toHaveLength(2);
        expect(output).toContain('+first');
        expect(output).toContain('+second');
        expect(output).not.toContain('line 15');
    });

    it('strips carriage returns and the "no newline" marker', () => {
        const output = plain(renderDiff('a\r\nb\r\n', 'a\r\nc'));

        expect(output).not.toContain('\r');
        expect(output).not.toContain('No newline');
        expect(output).toContain('-b');
        expect(output).toContain('+c');
    });
});
