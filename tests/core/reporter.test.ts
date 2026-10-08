import { describe, expect, it } from 'vitest';
import { Reporter } from '../../src/core/reporter.js';

describe('Reporter', () => {
    it('records messages with their level, file and line', () => {
        const report = new Reporter();
        report.todo('a.js', 'check this', 3);
        report.warn('b.js', 'careful');
        report.info('c.js', 'fyi', 7);

        expect(report.messages).toEqual([
            { level: 'todo', file: 'a.js', line: 3, message: 'check this' },
            { level: 'warning', file: 'b.js', line: undefined, message: 'careful' },
            { level: 'info', file: 'c.js', line: 7, message: 'fyi' },
        ]);
    });

    it('drops exact duplicates', () => {
        const report = new Reporter();
        report.todo('a.js', 'check this', 3);
        report.todo('a.js', 'check this', 3);

        expect(report.messages).toHaveLength(1);
    });

    it('keeps messages that differ in level, file, line or text', () => {
        const report = new Reporter();
        report.todo('a.js', 'check this', 3);
        report.warn('a.js', 'check this', 3);
        report.todo('b.js', 'check this', 3);
        report.todo('a.js', 'check this', 4);
        report.todo('a.js', 'check that', 3);

        expect(report.messages).toHaveLength(5);
    });
});
