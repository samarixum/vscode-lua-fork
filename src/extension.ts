import * as vscode from "vscode";
import * as languageserver from "./languageserver.ts";

// Create a global output channel for BetterGit logging
export const outputChannel = vscode.window.createOutputChannel(
  "Lua (moonsharp)",
  { log: true },
);
let outputChannelClosed = false;

export function log(
  message: string,
  level: "info" | "warn" | "error" = "info",
) {
  if (outputChannelClosed) {
    return;
  }

  try {
    outputChannel.appendLine(
      `[Lua (moonsharp)] [${level.toUpperCase()}] ${message}`,
    );
  } catch {
    outputChannelClosed = true;
  }
}

export function debug(message: string) {
  log(message, "info");
}

export function disposeOutputChannel() {
  if (outputChannelClosed) {
    return;
  }

  outputChannelClosed = true;
  try {
    outputChannel.dispose();
  } catch {
    // Ignore disposal errors during shutdown.
  }
}

export function activate(context: vscode.ExtensionContext) {
  log("Extension activated");

  languageserver.activate(context);

  return {
    async reportAPIDoc(params: unknown) {
      await languageserver.reportAPIDoc(params);
    },
    async setConfig(changes: languageserver.ConfigChange[]) {
      await languageserver.setConfig(changes);
    },
  };
}

export async function deactivate() {
  debug("Deactivating Lua extension");
  await languageserver.deactivate();
  debug("Extension deactivated");
  disposeOutputChannel();
}
