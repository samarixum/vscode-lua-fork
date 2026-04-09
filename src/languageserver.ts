import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import * as LSP from 'vscode-languageserver-protocol';
import {
    workspace as Workspace,
    ExtensionContext,
    commands as Commands,
    TextDocument,
    Uri,
    window,
    Disposable,
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DocumentSelector,
    LSPAny,
    ExecuteCommandRequest,
    TransportKind,
} from 'vscode-languageclient/node.js';

import { log, debug, outputChannel } from './extension.ts';

export let defaultClient: LuaClient | null = null;

function registerCustomCommands(context: ExtensionContext) {
    debug('Registering custom commands for Lua extension');

    context.subscriptions.push(Commands.registerCommand('lua.config', (changes) => {
        debug(`Received lua.config command with ${changes?.length} changes`);
        const propMap: Record<string, Record<string, unknown>> = {};

        for (const data of changes) {
            debug(`Processing config action: ${data.action} for key: ${data.key}`);
            const config = Workspace.getConfiguration(undefined, Uri.parse(data.uri));

            if (data.action === 'add') {
                const value = config.get(data.key);
                if (!Array.isArray(value)) {
                    log(`Error: ${data.key} is not an Array! Cannot perform 'add' action.`, 'error');
                    throw new Error(`${data.key} is not an Array!`);
                }
                value.push(data.value);
                config.update(data.key, value, data.global);
                debug(`Successfully added value to ${data.key}`);
                continue;
            }
            if (data.action === 'set') {
                config.update(data.key, data.value, data.global);
                debug(`Successfully set ${data.key} to ${JSON.stringify(data.value)}`);
                continue;
            }
            if (data.action === 'prop') {
                if (!(data.key in propMap)) {
                    const prop = config.get(data.key);
                    if (typeof prop === 'object' && prop !== null) {
                        propMap[data.key] = prop as Record<string, unknown>;
                    }
                }
                propMap[data.key][data.prop] = data.value;
                config.update(data.key, propMap[data.key], data.global);
                debug(`Updated property ${data.prop} in ${data.key}`);
                continue;
            }
        }
    }));

    context.subscriptions.push(Commands.registerCommand('lua.exportDocument', async () => {
        debug('Command lua.exportDocument triggered');
        if (!defaultClient) {
            log('Export failed: defaultClient is not initialized');
            return;
        }
        const outputs = await vscode.window.showOpenDialog({
            defaultUri: vscode.Uri.joinPath(context.extensionUri, 'server', 'log'),
            openLabel: "Export to this folder",
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
        });
        const output = outputs?.[0];
        if (!output) {
            debug('Export canceled by user (no folder selected)');
            return;
        }
        log(`Exporting document to: ${output.fsPath}`);
        defaultClient.client?.sendRequest(ExecuteCommandRequest.type, {
            command: 'lua.exportDocument',
            arguments: [output.toString()],
        });
    }));

    context.subscriptions.push(Commands.registerCommand('lua.reloadFFIMeta', async () => {
        debug('Command lua.reloadFFIMeta triggered');
        defaultClient?.client?.sendRequest(ExecuteCommandRequest.type, {
            command: 'lua.reloadFFIMeta',
        });
    }));

    context.subscriptions.push(Commands.registerCommand('lua.startServer', async () => {
        log('Manual server start requested');
        deactivate();
        createClient(context);
    }));

    context.subscriptions.push(Commands.registerCommand('lua.stopServer', async () => {
        log('Manual server stop requested');
        deactivate();
    }));

    context.subscriptions.push(Commands.registerCommand('lua.showReferences', (uri: string, position: Record<string, number>, locations: any[]) => {
        debug(`Showing references for ${uri} at line ${position.line}`);
        vscode.commands.executeCommand(
            'editor.action.showReferences',
            vscode.Uri.parse(uri),
            new vscode.Position(position.line, position.character),
            locations.map((value) => {
                return new vscode.Location(
                    vscode.Uri.parse(value.uri as any as string),
                    new vscode.Range(
                        value.range.start.line,
                        value.range.start.character,
                        value.range.end.line,
                        value.range.end.character,
                    ),
                );
            })
        );
    }));
}

export async function reportAPIDoc(params: unknown) {
    if (!defaultClient) {
        return;
    }
    defaultClient.client?.sendNotification('$/api/report', params);
}

/** Creates a new {@link LuaClient} and starts it. */
export const createClient = (context: ExtensionContext) => {
    log('Initializing Lua Language Server creation...');
    defaultClient = new LuaClient(context, [{ language: 'lua' }]);
    defaultClient.start();
};

class LuaClient extends Disposable {
    public client: LanguageClient | undefined;
    private disposables = new Array<Disposable>();
    constructor(
        private context: ExtensionContext,
        private documentSelector: DocumentSelector
    ) {
        super(() => {
            debug('LuaClient super-disposable triggered');
            for (const disposable of this.disposables) {
                disposable.dispose();
            }
        });
    }

    async start() {
        log('Starting Lua Language Server client sequence');

        const clientOptions: LanguageClientOptions = {
            documentSelector: this.documentSelector,
            progressOnInitialization: true,
            markdown: { isTrusted: true, supportHtml: true },
            outputChannel: outputChannel,
            initializationOptions: {
                changeConfiguration: true,
                statusBar: true,
                viewDocument: true,
                trustByClient: true,
                useSemanticByRange: true,
                codeLensViewReferences: true,
                fixIndents: true,
                languageConfiguration: true,
                storagePath: this.context.globalStorageUri.fsPath,
            },
            middleware: {
                provideHover: async () => undefined,
            }
        };

        const config = Workspace.getConfiguration(undefined, vscode.workspace.workspaceFolders?.[0]);
        const commandParam = config.get("Lua.misc.parameters");
        
        debug(`Locating server executable...`);
        const command = await this.getCommand(config);
        log(`Server binary found: ${command}`);

        if (!Array.isArray(commandParam)) {
            log('Error: Lua.misc.parameters is not an array', 'error');
            throw new Error("Lua.misc.parameters must be an Array!");
        }

        const port = this.getPort(commandParam);
        if (port) {
            log(`TCP Socket transport detected on port: ${port}`);
        } else {
            debug('Using default transport (STDIO)');
        }

        const serverOptions: ServerOptions = {
            command: command,
            transport: port ? { kind: TransportKind.socket, port: port } : undefined,
            args: commandParam,
            options: { cwd: path.dirname(path.dirname(command)) },
        };

        this.client = new LanguageClient("Lua", "Lua", serverOptions, clientOptions);
        this.disposables.push(this.client);

        debug('Attempting to start LanguageClient...');
        await this.client.start();
        log('LanguageClient started successfully');

        this.onCommand();
        this.statusBar();
        this.languageConfiguration();
        this.provideHover();
    }

    private async getCommand(config: vscode.WorkspaceConfiguration) {
        const executablePath = config.get("Lua.misc.executablePath");

        if (typeof executablePath !== "string") {
            log('Error: Lua.misc.executablePath is not a string', 'error');
            throw new Error("Lua.misc.executablePath must be a string!");
        }

        if (executablePath && executablePath !== "") {
            debug(`Using user-defined executable path: ${executablePath}`);
            return executablePath;
        }

        const platform: string = os.platform();
        let command: string;
        let binDir: string | undefined;

        debug(`Platform detected: ${platform}. Checking internal server binaries.`);

        try {
            if ((await fs.promises.stat(this.context.asAbsolutePath("server/bin"))).isDirectory()) {
                binDir = "bin";
            }
        } catch (error) {
            debug(`Internal "server/bin" directory not found: ${error}`);
            debug('falling back to platform-specific folders');
        }

        switch (platform) {
            case "win32":
                command = this.context.asAbsolutePath(path.join("server", binDir || "bin-Windows", "lua-language-server.exe"));
                break;
            case "linux":
                command = this.context.asAbsolutePath(path.join("server", binDir || "bin-Linux", "lua-language-server"));
                await fs.promises.chmod(command, 0o777);
                break;
            case "darwin":
                command = this.context.asAbsolutePath(path.join("server", binDir || "bin-macOS", "lua-language-server"));
                await fs.promises.chmod(command, 0o777);
                break;
            default:
                throw new Error(`Unsupported operating system "${platform}"!`);
        }
        return command;
    }

    private getPort(commandParam: string[]): number | undefined {
        const portIndex = commandParam.findIndex((value) => value.startsWith("--socket"));
        if (portIndex === -1) return undefined;
        
        const port = commandParam[portIndex].split("=")[1] ||
                     commandParam[portIndex].split(" ")[1] ||
                     commandParam[portIndex + 1];
        
        return port ? Number(port) : undefined;
    }

    async stop() {
        debug('LuaClient.stop() called');
        this.client?.stop();
        this.dispose();
    }

    private statusBar() {
        debug('Initializing StatusBar notifications');
        const client = this.client!;
        const bar = window.createStatusBarItem(vscode.StatusBarAlignment.Right);
        bar.text = "Lua";
        bar.command = "Lua.statusBar";
        
        this.disposables.push(Commands.registerCommand(bar.command, () => {
            debug('StatusBar clicked, sending click notification to server');
            client.sendNotification("$/status/click");
        }));
        
        this.disposables.push(client.onNotification("$/status/show", () => {
            debug('Server requested StatusBar show');
            bar.show();
        }));
        
        this.disposables.push(client.onNotification("$/status/hide", () => {
            debug('Server requested StatusBar hide');
            bar.hide();
        }));
        
        this.disposables.push(client.onNotification("$/status/report", (params: { text: string; tooltip: string }) => {
            bar.text = params.text;
            bar.tooltip = params.tooltip;
        }));
        
        client.sendNotification("$/status/refresh");
        this.disposables.push(bar);
    }

    private onCommand() {
        if (!this.client) return;
        this.disposables.push(
            this.client.onNotification("$/command", (params: { command: string; data: any }) => {
                debug(`Server requested execution of VS Code command: ${params.command}`);
                Commands.executeCommand(params.command, params.data);
            })
        );
    }

    private languageConfiguration() {
        if (!this.client) return;

        function convertStringsToRegex(config: any): any {
            if (typeof config !== 'object' || config === null) return config;
            for (const key in config) {
                if (Object.prototype.hasOwnProperty.call(config, key)) {
                    const value = config[key];
                    if (typeof value === 'object' && value !== null) convertStringsToRegex(value);
                    if ((key === 'beforeText' || key === 'afterText') && typeof value === 'string') {
                        config[key] = new RegExp(value);
                    }
                }
            }
            return config;
        }

        let configuration: Disposable | undefined;
        this.disposables.push(
            this.client.onNotification('$/languageConfiguration', (params: { id: string; configuration: any }) => {
                debug(`Server updated language configuration for: ${params.id}`);
                configuration?.dispose();
                configuration = vscode.languages.setLanguageConfiguration(params.id, convertStringsToRegex(params.configuration));
                this.disposables.push(configuration);
            })
        );
    }

    private provideHover() {
        debug('Registering custom VerboseHover provider');
        const client = this.client;
        const levelMap = new WeakMap<vscode.VerboseHover, number>();
        const provider = vscode.languages.registerHoverProvider('lua', {
            provideHover: async (document, position, token, context?: vscode.HoverContext) => {
                if (!client) return null;
                
                let level = 1;
                if (context?.previousHover) {
                    level = levelMap.get(context.previousHover) ?? 0;
                    if (context.verbosityDelta !== undefined) {
                        level += context.verbosityDelta;
                    }
                }
                
                debug(`Hover requested at ${position.line}:${position.character} with verbosity level: ${level}`);

                const params = {
                    level: level,
                    ...client.code2ProtocolConverter.asTextDocumentPositionParams(document, position),
                };

                return client.sendRequest<LSP.Hover | null>('textDocument/hover', params, token).then((result) => {
                    if (token.isCancellationRequested || !result) return null;

                    const verboseResult = result as LSP.Hover & { maxLevel?: number };
                    const maxLevel = verboseResult.maxLevel ?? 0;
                    const hover = client.protocol2CodeConverter.asHover(result);
                    
                    if (!hover) return null;

                    const verboseHover = new vscode.VerboseHover(
                        hover.contents,
                        hover.range,
                        level < maxLevel,
                        level > 0,
                    );

                    if (level > maxLevel) level = maxLevel;
                    levelMap.set(verboseHover, level);
                    return verboseHover;
                }, (error) => {
                    log(`Hover request failed: ${error}`, 'error');
                    return client.handleFailedRequest(LSP.HoverRequest.type, token, error, null);
                });
            }
        });
        this.disposables.push(provider);
    }
};

export function activate(context: ExtensionContext) {
    log('Lua Extension Activation started');
    registerCustomCommands(context);

    function didOpenTextDocument(document: TextDocument) {
        if (document.languageId !== 'lua') {
            debug(`Ignoring non-Lua document: ${document.uri.fsPath}`);
            return;
        }

        log(`Lua document detected: ${document.uri.fsPath}`);
        if (!defaultClient) {
            log('No active client found. Creating client for the first Lua document.');
            createClient(context);
        }
    }

    Workspace.onDidOpenTextDocument(didOpenTextDocument);
    Workspace.textDocuments.forEach(didOpenTextDocument);
}

export async function deactivate() {
    log('Extension deactivation sequence initiated');
    if (defaultClient) {
        debug('Cleaning up default LuaClient instance');
        await defaultClient.stop();
        defaultClient = null;
    }
    if (outputChannel) {
        debug('Disposing output channel');
        outputChannel.dispose();
    }
    log('Extension deactivated');
    return undefined;
}

export type ConfigChange = {
    action:  "set",
    key:     string,
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
} | {
    action:  "add",
    key:     string,
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
} | {
    action:  "prop",
    key:     string,
    prop:    string;
    value:   LSPAny,
    uri:     vscode.Uri,
    global?: boolean,
}

export async function setConfig(changes: ConfigChange[]): Promise<boolean> {
    if (!defaultClient) {
        log('setConfig called but defaultClient is null', 'warn');
        return false;
    }
    debug(`Sending lua.setConfig request to server with ${changes.length} items`);
    const params = changes.map(change => ({
        ...change,
        uri: change.uri.toString(),
        prop: (change.action === "prop") ? (change as any).prop : undefined
    }));

    await defaultClient.client?.sendRequest(ExecuteCommandRequest.type, {
        command: 'lua.setConfig',
        arguments: params,
    });
    return true;
}

export async function getConfig(key: string, uri: vscode.Uri): Promise<LSPAny> {
    if (!defaultClient) return undefined;
    debug(`Requesting config for key: ${key} via LSP`);
    return await defaultClient.client?.sendRequest(ExecuteCommandRequest.type, {
        command: 'lua.getConfig',
        arguments: [{ uri: uri.toString(), key: key }]
    });
}