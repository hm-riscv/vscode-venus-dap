import * as vscode from 'vscode'
import fs from 'fs'
import simulator = require('../runtime/riscvSimulator');
import range from 'lodash/range';
import { TheiaCompatibleVscodeUri } from '../theia/polyfill';

/**
 * Manages cat coding webview panels
 */
export class MemoryUI {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static instance: MemoryUI | undefined;

	public static readonly viewType = 'venusUI';
	private _panel: vscode.WebviewPanel;
	private _extensionUri: TheiaCompatibleVscodeUri;
	private _disposables: vscode.Disposable[] = [];
	private _uiState: UIState;

	public static getInstance(): MemoryUI {
		if (MemoryUI.instance) {
			return MemoryUI.instance
		} else {
			MemoryUI.instance = new MemoryUI()
			return MemoryUI.instance
		}
	}

	/** Closes the old instance if available and opens a new one */
	public static createNewInstance(): MemoryUI {
		if (MemoryUI.instance) {
			MemoryUI.instance.dispose();
		}
		MemoryUI.instance = new MemoryUI()
		return MemoryUI.instance
	}

	private constructor() {
		this._uiState = new UIState();
	}


	public dispose() {
		MemoryUI.instance = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	public show(extensionUri: TheiaCompatibleVscodeUri) {
		// If we already have a panel, show it.
		if (MemoryUI.instance?._panel) {
			MemoryUI.instance._panel.reveal();
		} else {
			this._addPanel(extensionUri);
		}
	}

	public update() {
		if (this._panel && this._panel.visible && this._panel.webview) {
			this._uiState.update()
			const lines = this._uiState.getMemoryInDisplayFormat()

			this._panel.webview.postMessage({
				command: "updateMemory",
				lines: lines
			})
		}
	}

	public resetMemory() {

	}

	private _addPanel(extensionUri: TheiaCompatibleVscodeUri) {

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			MemoryUI.viewType,
			'Memory',
			vscode.ViewColumn.Beside,
			{
				// Enable javascript in the webview
				enableScripts: true,

				// And restrict the webview to only loading content from our extension's `src/memoryui` directory.
				localResourceRoots: [vscode.Uri.file(extensionUri + '/src/memoryui')]
			}
		);

		this._panel = panel;
		this._extensionUri = extensionUri;

		const webview = this._panel.webview;
		this._panel.webview.html = this._getHtmlForWebview(webview);

		// Set the webview's initial html content
		this.update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					this.update();
				}
			},
			null,
			this._disposables
		);

		const moveMemoryBy = (rows: number) => {
			const bytes = 4 * rows
			if (this._uiState.activeMemoryAddress + bytes < 0) return
			this._uiState.activeMemoryAddress += bytes
			this.update()
		}

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'moveMemoryJump':
						const segment = message.segment as MemorySegmentOption
						const address = MemorySegmentAdresses.get(segment) || MemorySegments.TEXT_BEGIN
						this._uiState.activeMemoryAddress = address
						this.update()
						return;
					case 'moveMemoryLocation':
						let {memAddress} = message
						memAddress = parseInt(memAddress, 16) // TODO parse with utils.kt's userStringToInt()
						this._uiState.activeMemoryAddress = memAddress
						this.update()
						return;
					case 'moveMemoryUp':
						moveMemoryBy(+this._uiState.MEMORY_CONTEXT)
						return;
					case 'moveMemoryDown':
						moveMemoryBy(-this._uiState.MEMORY_CONTEXT)
						return;
					case 'updateDisplayType':
						const {displayType} = message
						this._uiState.setDisplayType(displayType)
						this.update()
				}
			},
			null,
			this._disposables
		);
	}

	private _getHtmlForWebview(webview: vscode.Webview, ) {

		const htmlPathOnDisk = vscode.Uri.file(this._extensionUri + '/src/memoryui/memoryUI.html');
		var htmlpath = htmlPathOnDisk.fsPath;
		var html = fs.readFileSync(htmlpath).toString();

		const onDiskPath = vscode.Uri.file(this._extensionUri + '/src/memoryui/memoryUI.js');
		const scriptSrc = webview.asWebviewUri(onDiskPath);
		html = html.replace('${scriptSrc}', scriptSrc.toString());

		const stylePath = vscode.Uri.file(this._extensionUri + '/src/memoryui/memoryUI.css');
		const styleSrc = webview.asWebviewUri(stylePath);
		html = html.replace('${styleSrc}', styleSrc.toString());

		return html;
	}

}

class UIState {
	public activeMemoryAddress = 0
	private displayType = DisplayType.HEX
	public memory: Array<MemoryLine>
	public readonly MEMORY_CONTEXT = 6

	constructor() {
		this.memory = []
	}

	public getMemoryInDisplayFormat(): Array<MemoryLine> {
		const toHex = (decimal) => (decimal >>> 0).toString(16).toUpperCase().padStart(2, "0")
		const toDecimal = (decimal) => Int8Array.of(decimal)[0].toString(10)
		const toUnsigned = (decimal) => (decimal >>> 0).toString(10)
		const toAscii = (decimal) => {
			if (decimal < 32 || 126 < decimal) {
				return "0x" + toHex(decimal)
			}
			return String.fromCharCode(decimal >>> 0)
		}

		let formatter: (decimal: number) => string
		switch (this.displayType) {
			case DisplayType.HEX:
				formatter = toHex
				break
			case DisplayType.DECIMAL:
				formatter = toDecimal
				break
			case DisplayType.UNSIGNED:
				formatter = toUnsigned
				break
			case DisplayType.ASCII:
				formatter = toAscii
				break
		}
		return this.memory.map(line => Object.assign(
				{},
				line,
				{bytes: line.bytes.map(byte => formatter(byte))}
			))
	}

	public setDisplayType(displayType: DisplayType) {
		if (Object.values(DisplayType).includes(displayType)) {
			this.displayType = displayType
		}
	}

	/**
	 * Reads the memory cells from the simulator and updates the interal memory of the UIstate.
	 * This depends on the active-memory-address (AMA)
	 * and on how much words around the AMA should be displayed (Memory Context)
	 */
	public update() {
		this.activeMemoryAddress = this.activeMemoryAddress >>> 2 << 2
		this.memory = []
		for (const rowIdx of range(-this.MEMORY_CONTEXT, this.MEMORY_CONTEXT + 1)) {
			const rowAddr = this.activeMemoryAddress + 4 * rowIdx
			const bytes = range(0,4)
				.map(i => simulator.driver.sim.loadByte_3p81yu$(rowAddr + i))
			this.memory.push({rowIdx, rowAddr, bytes})
		}
	}
}

enum DisplayType {
	HEX = "Hex", DECIMAL = "Decimal", UNSIGNED = "Unsigned", ASCII = "ASCII"
}

interface MemoryLine {
	rowIdx: number,
	rowAddr: number,
	bytes: Array<number>
}

enum MemorySegmentOption {
	TEXT = "Text", DATA = "Data", HEAP = "Heap", STACK = "Stack"
}

enum MemorySegments {
    // Memory address where the stack segment starts (growing downwards)
    STACK_BEGIN = 0x7fff_fff0,
    // Memory address where the heap segment starts
    HEAP_BEGIN = 0x1000_8000,
    // Memory address where the data segment starts
    STATIC_BEGIN = 0x1000_0000,
    // Memory address where the text segment starts
    TEXT_BEGIN = 0x0000_0000
}

const MemorySegmentAdresses = new Map<string, number>([
	[MemorySegmentOption.TEXT, MemorySegments.TEXT_BEGIN],
	[MemorySegmentOption.DATA, MemorySegments.STATIC_BEGIN],
	[MemorySegmentOption.HEAP, MemorySegments.HEAP_BEGIN],
	[MemorySegmentOption.STACK, MemorySegments.STACK_BEGIN],
])