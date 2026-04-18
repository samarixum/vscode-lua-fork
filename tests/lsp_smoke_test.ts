import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ServerCase = {
    name: string;
    runtimeVersion: string;
};

type RpcRequest = {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: unknown;
};

type RpcNotification = {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
};

type RpcResponse = {
    jsonrpc: "2.0";
    id: number | string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};

type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(CLIENT_DIR, "..", "..");
const SERVER_ROOT = resolve(REPO_ROOT, "submodules/server");
const STAGED_SERVER_ROOT = resolve(REPO_ROOT, "Build/TMP/server/bin");
const SOURCE_SERVER_ROOT = resolve(REPO_ROOT, "submodules/server/bin");
const FIXTURE_WORKSPACE_DIR = resolve(TEST_DIR, "fixtures/workspace");

const INITIALIZE_TIMEOUT_MS = 15000;
const DIAGNOSTIC_TIMEOUT_MS = 30000;

const SERVER_CASES: ServerCase[] = [
    {
        name: "moonsharpy",
        runtimeVersion: "Moonsharp 2.0.0.0",
    },
    {
        name: "lua-language-server",
        runtimeVersion: "Lua 5.4",
    },
];

class Deferred<T> {
    public promise: Promise<T>;
    public resolve!: (value: T) => void;
    public reject!: (reason?: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

function executableName(baseName: string) {
    return Deno.build.os === "windows" ? `${baseName}.exe` : baseName;
}

function normalizeJson(value: unknown) {
    return JSON.parse(JSON.stringify(value));
}

function hasMethod(message: RpcMessage): message is RpcRequest | RpcNotification {
    return typeof (message as { method?: unknown }).method === "string";
}

function hasId(message: RpcMessage): message is RpcRequest | RpcResponse {
    return Object.prototype.hasOwnProperty.call(message, "id");
}

function isRequest(message: RpcMessage): message is RpcRequest {
    return hasMethod(message) && hasId(message);
}

function isResponse(message: RpcMessage): message is RpcResponse {
    return hasId(message) && !hasMethod(message);
}

function resolveServerBinary(caseName: string) {
    const envKey = caseName === "moonsharpy"
        ? "MOONSHARP_TEST_BINARY"
        : "LUA_LANGUAGE_SERVER_TEST_BINARY";
    const override = Deno.env.get(envKey);
    if (override && override.trim() !== "") {
        const absoluteOverride = resolve(override.trim());
        if (existsSync(absoluteOverride)) {
            return absoluteOverride;
        }

        throw new Error(`Unable to find ${caseName} binary from ${envKey}: ${absoluteOverride}`);
    }

    const candidateRoots = [
        Deno.env.get("LSP_TEST_BIN_ROOT"),
        SOURCE_SERVER_ROOT,
        STAGED_SERVER_ROOT,
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "");

    const exeName = executableName(caseName);
    const tried: string[] = [];

    for (const root of candidateRoots) {
        const candidate = resolve(root, exeName);
        tried.push(candidate);
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Unable to locate ${caseName} executable. Tried:\n${tried.join("\n")}`);
}

function buildWorkspaceConfiguration(runtimeVersion: string) {
    const libraryRoots = [SERVER_ROOT, REPO_ROOT];

    return {
        "files.associations": {
            "*.lua": "lua",
        },
        "Lua": {
            runtime: {
                version: runtimeVersion,
            },
            workspace: {
                library: libraryRoots,
                checkThirdParty: false,
            },
            diagnostics: {
                enable: true,
            },
            completion: {
                enable: true,
            },
            telemetry: {
                enable: false,
            },
            misc: {
                executablePath: "",
                parameters: [],
            },
        },
        "Lua.runtime.version": runtimeVersion,
        "Lua.workspace.library": libraryRoots,
        "Lua.workspace.checkThirdParty": false,
        "Lua.diagnostics.enable": true,
        "Lua.completion.enable": true,
        "Lua.telemetry.enable": false,
        "Lua.misc.executablePath": "",
        "Lua.misc.parameters": [],
    };
}

function resolveConfigurationValue(section: string | null | undefined, runtimeVersion: string) {
    const bundle = buildWorkspaceConfiguration(runtimeVersion);

    switch (section) {
        case undefined:
        case null:
        case "":
            return normalizeJson(bundle);
        case "files.associations":
            return normalizeJson(bundle["files.associations"]);
        case "Lua":
            return normalizeJson(bundle["Lua"]);
        case "Lua.runtime":
            return normalizeJson({
                version: runtimeVersion,
            });
        case "Lua.runtime.version":
            return runtimeVersion;
        case "Lua.workspace":
            return normalizeJson({
                library: bundle["Lua.workspace.library"],
                checkThirdParty: false,
            });
        case "Lua.workspace.library":
            return normalizeJson(bundle["Lua.workspace.library"]);
        case "Lua.workspace.checkThirdParty":
            return false;
        case "Lua.diagnostics":
            return normalizeJson({
                enable: true,
            });
        case "Lua.diagnostics.enable":
            return true;
        case "Lua.completion":
            return normalizeJson({
                enable: true,
            });
        case "Lua.completion.enable":
            return true;
        case "Lua.telemetry":
            return normalizeJson({
                enable: false,
            });
        case "Lua.telemetry.enable":
            return false;
        case "Lua.misc":
            return normalizeJson({
                executablePath: "",
                parameters: [],
            });
        case "Lua.misc.executablePath":
            return "";
        case "Lua.misc.parameters":
            return [];
        default:
            return undefined;
    }
}

function messageKey(message: RpcMessage) {
    return hasId(message) ? `id:${String(message.id)}` : `method:${message.method}`;
}

function makeHeaderBodyMessage(payload: unknown) {
    const body = JSON.stringify(payload);
    const encodedBody = new TextEncoder().encode(body);
    const header = new TextEncoder().encode(
        `Content-Length: ${encodedBody.length}\r\n\r\n`,
    );

    const message = new Uint8Array(header.length + encodedBody.length);
    message.set(header, 0);
    message.set(encodedBody, header.length);
    return message;
}

const CONTENT_LENGTH_BYTES = new TextEncoder().encode("Content-Length:");
const HEADER_DELIMITER_BYTES = new Uint8Array([13, 10, 13, 10]);

function indexOfBytes(buffer: Uint8Array, pattern: Uint8Array, startIndex = 0) {
    if (pattern.length === 0) {
        return startIndex;
    }

    outer: for (let index = startIndex; index <= buffer.length - pattern.length; index += 1) {
        for (let offset = 0; offset < pattern.length; offset += 1) {
            if (buffer[index + offset] !== pattern[offset]) {
                continue outer;
            }
        }

        return index;
    }

    return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}

function tryReadMessage(buffer: Uint8Array) {
    const headerStart = indexOfBytes(buffer, CONTENT_LENGTH_BYTES);
    if (headerStart === -1) {
        return null;
    }

    const headerEnd = indexOfBytes(buffer, HEADER_DELIMITER_BYTES, headerStart);
    if (headerEnd === -1) {
        return null;
    }

    const headerText = new TextDecoder().decode(buffer.slice(headerStart, headerEnd));
    const match = headerText.match(/content-length:\s*(\d+)/i);
    if (!match) {
        throw new Error(`Missing Content-Length header in:\n${headerText}`);
    }

    const bodyLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + bodyLength;
    if (buffer.length < bodyEnd) {
        return null;
    }

    const bodyText = new TextDecoder().decode(buffer.slice(bodyStart, bodyEnd));
    const message = JSON.parse(bodyText) as RpcMessage;
    return {
        message,
        rest: buffer.slice(bodyEnd),
    };
}

function timeoutAfter(ms: number) {
    let timeoutId: number | undefined;
    const promise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timed out after ${ms}ms`));
        }, ms) as unknown as number;
    });

    return {
        promise,
        cancel() {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
        },
    };
}

class LspSession {
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private readonly statusPromise: Promise<Deno.CommandStatus>;
    private readonly stdoutPump: Promise<void>;
    private readonly stderrPump: Promise<void>;
    private readonly pendingResponses = new Map<string, Deferred<unknown>>();
    private readonly notifications: RpcMessage[] = [];
    private messageSignal = new Deferred<void>();
    private readonly stderrLines: string[] = [];
    private readonly notes: string[] = [];
    private nextRequestId = 1;
    private closed = false;

    private constructor(
        private readonly process: Deno.ChildProcess,
        private readonly runtimeVersion: string,
    ) {
        this.writer = process.stdin.getWriter();
        this.statusPromise = process.status;
        this.stdoutPump = this.pumpStdout();
        this.stderrPump = this.pumpStderr();
    }

    static spawn(binaryPath: string, runtimeVersion: string) {
        const process = new Deno.Command(binaryPath, {
            cwd: SERVER_ROOT,
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn();

        return new LspSession(process, runtimeVersion);
    }

    private signalMessage() {
        this.messageSignal.resolve();
        this.messageSignal = new Deferred<void>();
    }

    private async writeMessage(payload: unknown) {
        await this.writer.write(makeHeaderBodyMessage(payload));
    }

    private async pumpStdout() {
        const reader = this.process.stdout.getReader();
        let buffer = new Uint8Array();

        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }

                if (chunk.value && chunk.value.length > 0) {
                    buffer = concatBytes(buffer, chunk.value);

                    while (true) {
                        const parsed = tryReadMessage(buffer);
                        if (!parsed) {
                            break;
                        }

                        buffer = parsed.rest;
                        await this.handleMessage(parsed.message);
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    private async pumpStderr() {
        const reader = this.process.stderr.getReader();
        const decoder = new TextDecoder();
        let bufferedText = "";

        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }

                bufferedText += decoder.decode(chunk.value, { stream: true });
                let lineBreakIndex = bufferedText.indexOf("\n");
                while (lineBreakIndex !== -1) {
                    const line = bufferedText.slice(0, lineBreakIndex).replace(/\r$/, "");
                    this.stderrLines.push(line);
                    bufferedText = bufferedText.slice(lineBreakIndex + 1);
                    lineBreakIndex = bufferedText.indexOf("\n");
                }
            }
        } finally {
            bufferedText += decoder.decode();
            if (bufferedText) {
                this.stderrLines.push(bufferedText.replace(/\r$/, ""));
            }
            reader.releaseLock();
        }
    }

    private async handleMessage(message: RpcMessage) {
        if (isRequest(message)) {
            const result = await this.handleServerRequest(message);
            await this.writeMessage({
                jsonrpc: "2.0",
                id: message.id,
                result,
            });
            this.notes.push(messageKey(message));
            this.signalMessage();
            return;
        }

        if (isResponse(message)) {
            const pending = this.pendingResponses.get(String(message.id));
            if (pending) {
                this.pendingResponses.delete(String(message.id));
                if (message.error) {
                    pending.reject(new Error(`Request ${String(message.id)} failed: ${message.error.message}`));
                } else {
                    pending.resolve(message.result);
                }
            }

            this.notes.push(messageKey(message));
            this.signalMessage();
            return;
        }

        this.notifications.push(message);
        this.notes.push(messageKey(message));
        this.signalMessage();
    }

    private handleServerRequest(message: RpcRequest) {
        switch (message.method) {
            case "workspace/configuration": {
                const items = Array.isArray((message.params as { items?: unknown[] } | undefined)?.items)
                    ? (message.params as { items: Array<{ section?: string | null }> }).items
                    : [];

                return items.map((item) => {
                    return resolveConfigurationValue(item.section, this.runtimeVersion);
                });
            }
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "window/showMessageRequest":
                return null;
            case "workspace/applyEdit":
                return { applied: true };
            default:
                return null;
        }
    }

    async request(method: string, params?: unknown, timeoutMs = INITIALIZE_TIMEOUT_MS) {
        const id = this.nextRequestId;
        this.nextRequestId += 1;
        const pending = new Deferred<unknown>();
        this.pendingResponses.set(String(id), pending);

        const payload: Record<string, unknown> = {
            jsonrpc: "2.0",
            id,
            method,
        };
        if (params !== undefined) {
            payload.params = params;
        }

        await this.writeMessage(payload);

        const timeout = timeoutAfter(timeoutMs);
        try {
            return await Promise.race([
                pending.promise,
                timeout.promise,
            ]);
        } catch (error) {
            if (error instanceof Error && error.message === `Timed out after ${timeoutMs}ms`) {
                throw new Error(`Timed out waiting for request ${method}.\n${this.describeFailure()}`);
            }
            throw error;
        } finally {
            timeout.cancel();
        }
    }

    async notify(method: string, params?: unknown) {
        const payload: Record<string, unknown> = {
            jsonrpc: "2.0",
            method,
        };
        if (params !== undefined) {
            payload.params = params;
        }

        await this.writeMessage(payload);
    }

    async initialize(rootUri: string) {
        return await this.request(
            "initialize",
            {
                processId: Deno.pid,
                rootUri,
                rootPath: REPO_ROOT,
                workspaceFolders: [
                    {
                        uri: rootUri,
                        name: "RemakeEngine",
                    },
                ],
                capabilities: {
                    workspace: {
                        configuration: true,
                        workspaceFolders: true,
                    },
                    textDocument: {
                        synchronization: {
                            didSave: true,
                        },
                    },
                    general: {
                        positionEncodings: ["utf-16"],
                    },
                },
                clientInfo: {
                    name: "lsp-smoke-test",
                    version: "1.0.0",
                },
                initializationOptions: {
                    changeConfiguration: true,
                    statusBar: true,
                    viewDocument: true,
                    trustByClient: true,
                    useSemanticByRange: true,
                    codeLensViewReferences: true,
                    fixIndents: true,
                    languageConfiguration: true,
                    storagePath: resolve(REPO_ROOT, ".test-storage"),
                },
            },
        );
    }

    async waitForNotification(method: string, uri?: string, timeoutMs = DIAGNOSTIC_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;

        while (true) {
            const index = this.notifications.findIndex((message) => {
                if (!hasMethod(message) || message.method !== method) {
                    return false;
                }

                if (!uri) {
                    return true;
                }

                const params = message.params as { uri?: string; textDocument?: { uri?: string } } | undefined;
                const messageUri = params?.uri ?? params?.textDocument?.uri;
                return messageUri === uri;
            });

            if (index !== -1) {
                return this.notifications.splice(index, 1)[0];
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `Timed out waiting for ${method} for ${uri ?? "<any>"}.\n${this.describeFailure()}`,
                );
            }

            const timeout = timeoutAfter(remaining);
            try {
                await Promise.race([
                    this.messageSignal.promise,
                    timeout.promise,
                ]);
            } finally {
                timeout.cancel();
            }
        }
    }

    private describeFailure() {
        const stderrTail = this.stderrLines.slice(-25);
        const notesTail = this.notes.slice(-25);
        const parts = [
            `stderr (${stderrTail.length} lines):`,
            ...stderrTail,
            "",
            `messages (${notesTail.length} entries):`,
            ...notesTail,
        ];

        return parts.join("\n");
    }

    async close() {
        if (this.closed) {
            return;
        }

        this.closed = true;

        try {
            await this.writer.close();
        } catch {
            // Ignore shutdown noise during cleanup.
        }

        try {
            this.process.kill("SIGTERM");
        } catch {
            // Ignore kill errors when the process already exited.
        }

        await Promise.allSettled([
            this.stdoutPump,
            this.stderrPump,
            this.statusPromise,
        ]);
    }
}

async function runSmokeCase(testCase: ServerCase) {
    const binaryPath = resolveServerBinary(testCase.name);
    const rootUri = pathToFileURL(FIXTURE_WORKSPACE_DIR).href;

    const session = await LspSession.spawn(binaryPath, testCase.runtimeVersion);

    try {
        await session.initialize(rootUri);
        await session.notify("initialized", {});
        await session.waitForNotification("$/hello");
    } finally {
        await session.close();
    }
}

for (const testCase of SERVER_CASES) {
    Deno.test(`LSP smoke: ${testCase.name}`, async () => {
        await runSmokeCase(testCase);
    });
}