/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken, languages, workspace } from 'vscode';
import { VenusDebugSession } from './venusDebug';
import * as Net from 'net';
import { VenusRenderer } from './venusRenderer';
import path from 'path';
import fs from 'fs'
import { VenusLedMatrixUI, UIState, LedMatrix } from './ledmatrix/venusLedMatrixUI';
import { VenusRobotUI } from './robot/venusRobotUI';
import { VenusSevenSegBoardUI } from './sevensegboard/venusSevenSegBoardUI';
import { MemoryUI } from './memoryui/memoryUI';
import { venusTerminal } from './terminal/venusTerminal';
import { VenusMenuProvider } from './menu/venusMenu';

/*
 * The compile time flag 'runMode' controls how the debug adapter is run.
 * Please note: the test suite only supports 'external' mode.
 */
const runMode: 'external' | 'server' | 'inline' = 'inline';

export function activate(context: vscode.ExtensionContext) {

	VenusLedMatrixUI.createNewInstance(context.extensionPath, new UIState(new LedMatrix(10, 10)))
	VenusRobotUI.createNewInstance(context.extensionPath)
	VenusSevenSegBoardUI.createNewInstance(context.extensionPath)
	MemoryUI.createNewInstance()
	venusTerminal.create();

	context.subscriptions.push(vscode.commands.registerCommand('extension.riscv-venus.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a assembler file in the workspace folder",
			value: ""
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.setVariableFormat', async config => {
		const result = await vscode.window.showQuickPick(['hex', 'decimal', 'ascii', 'binary'], {
			placeHolder: "hex, decimal, ascii, or binary",
		});
		await vscode.workspace.getConfiguration('riscv-venus').update('variableFormat', result, false)
		return vscode.window.showInformationMessage(`Changed Variable Format to ${result}`)
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openLedMatrixUI', async config => {
		VenusLedMatrixUI.getInstance().show();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openRobotUI', async config => {
		VenusRobotUI.getInstance().show();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openSevenSegBoardUI', async config => {
		VenusSevenSegBoardUI.getInstance().show();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openSettings', async config => {
		vscode.commands.executeCommand('workbench.action.openSettings', 'riscv-venus');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.activate', () => {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('riscv-venus extension activated');
	  }));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openMemory', async config => {
		MemoryUI.getInstance().show(context.extensionPath);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openTerminal', async config => {
		venusTerminal.show();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('riscv-venus.openDocumentation', async config => {
		// Taken from: https://stackoverflow.com/questions/63960216/from-vs-code-extension-api-open-file-in-markdown-preview
		const uri = vscode.Uri.file(context.extensionPath +  '/src/documentation/manual.md')
		await vscode.commands.executeCommand("markdown.showPreview", uri);
		// let document =  await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'src', 'documentation', 'manual.md'))
		// vscode.window.showTextDocument(document, vscode.ViewColumn.Active, false)
	}));

	// This block makes sure that the Venus Options View is shown in the debugger
	// See: https://stackoverflow.com/questions/61555532/conditional-view-contribution-with-vscode-extension-api
	vscode.commands.executeCommand('setContext', 'venus:showOptionsMenu', true);

	vscode.window.registerTreeDataProvider(
		'riscv-venus.venusMenu',
		new VenusMenuProvider()
		);

	// register a configuration provider for 'venus' debug type
	const venusProvider = new VenusConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('venus', venusProvider));
	// register a content provider for the riscv-scheme

	// This makes sure that we have a instance active
	VenusRenderer.getInstance();

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicating via a socket
			factory = new MockDebugAdapterDescriptorFactory();
			break;

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new MockDebugAdapterDescriptorFactory();
			break;

		case 'external': default:
			// run the debug adapter as a separate process
			factory = new DebugAdapterExecutableFactory();
			break;
		}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('venus', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	/*
	vscode.languages.registerEvaluatableExpressionProvider('markdown', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	});
	*/
}

export function deactivate() {
	// Dont show Venus Options if the extension is not activated
	vscode.commands.executeCommand('setContext', 'venus:showOptionsMenu',
		false);

	venusTerminal.dispose();
}

class VenusConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'riscv') {
				config.type = 'venus';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {

	// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
	// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.

	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
		// param "executable" contains the executable optionally specified in the package.json (if any)

		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
		if (!executable) {
			const command = "absolute path to my DA executable";
			const args = [
				"some args",
				"another arg"
			];
			const options = {
				cwd: "working directory for executable",
				env: { "VAR": "some value" }
			};
			executable = new vscode.DebugAdapterExecutable(command, args, options);
		}

		// make VS Code launch the DA executable
		return executable;
	}
}

class MockDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new VenusDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new VenusDebugSession());
	}
}
