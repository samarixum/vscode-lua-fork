import * as vscode from 'vscode';
import * as languageserver from './languageserver.ts';

// Create a global output channel for BetterGit logging
export const outputChannel = vscode.window.createOutputChannel("Lua (moonsharp)", { log: true });

export function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    if (outputChannel) {
        outputChannel.appendLine(`[Lua (moonsharp)] [${level.toUpperCase()}] ${message}`);
    }
}

export function debug(message: string) {
    log(message, 'info');
}


export function activate(context: vscode.ExtensionContext) {
    log('Extension activated');

    languageserver.activate(context);

    return {
        async reportAPIDoc(params: unknown) {
            await languageserver.reportAPIDoc(params);
        },
        async setConfig(changes: languageserver.ConfigChange[]) {
            await languageserver.setConfig(changes);
        }
    };
}

export function deactivate() {
    debug('Deactivating Lua extension');
    languageserver.deactivate();
}
