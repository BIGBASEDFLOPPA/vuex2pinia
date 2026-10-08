export type MessageLevel = 'todo' | 'warning' | 'info';

export interface ReportMessage {
    level: MessageLevel;
    file: string;
    line?: number;
    message: string;
}

/** Collects everything the user has to review after the migration. */
export class Reporter {
    messages: ReportMessage[] = [];

    add(level: MessageLevel, file: string, message: string, line?: number): void {
        const duplicate = this.messages.some(
            (m) => m.level === level && m.file === file && m.line === line && m.message === message,
        );
        if (!duplicate) this.messages.push({ level, file, line, message });
    }

    todo(file: string, message: string, line?: number): void {
        this.add('todo', file, message, line);
    }

    warn(file: string, message: string, line?: number): void {
        this.add('warning', file, message, line);
    }

    info(file: string, message: string, line?: number): void {
        this.add('info', file, message, line);
    }
}
