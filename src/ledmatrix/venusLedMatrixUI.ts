import * as vscode from 'vscode'
import fs from 'fs'
import { TheiaCompatibleVscodeUri } from '../theia/polyfill';

/**
 * Manages a LED Matrix
 */
export class VenusLedMatrixUI {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static instance: VenusLedMatrixUI | undefined;

	public static readonly viewType = 'VenusLedMatrixUI';
	private _panel: vscode.WebviewPanel;
	private static _extensionUri: TheiaCompatibleVscodeUri;
	private _disposables: vscode.Disposable[] = [];
	private static _uiState: UIState;


	public static getInstance(): VenusLedMatrixUI {
		if (VenusLedMatrixUI.instance) {
			return VenusLedMatrixUI.instance
		} else {
			VenusLedMatrixUI.instance = new VenusLedMatrixUI(undefined, VenusLedMatrixUI._uiState)
			return VenusLedMatrixUI.instance
		}
	}

	/** Closes the old instance if available and opens a new one */
	public static createNewInstance(extensionUri?: TheiaCompatibleVscodeUri, uiState?: UIState): VenusLedMatrixUI {
		if (VenusLedMatrixUI.instance) {
			VenusLedMatrixUI.instance.dispose();
			VenusLedMatrixUI.instance = new VenusLedMatrixUI(extensionUri, uiState)
		} else {
			VenusLedMatrixUI.instance = new VenusLedMatrixUI(extensionUri, uiState)
		}
		return VenusLedMatrixUI.instance
	}

	private constructor(extensionUri?: TheiaCompatibleVscodeUri, uiState?: UIState) {
		if (extensionUri)
			VenusLedMatrixUI._extensionUri = extensionUri
		if (uiState) {
			VenusLedMatrixUI._uiState = uiState;
		} else {
			VenusLedMatrixUI._uiState = new UIState(new LedMatrix(10, 10))
		}
	}

	public dispose() {
		VenusLedMatrixUI.instance = undefined;

		// Clean up our resources
		if (this._panel != null) {
			this._panel.dispose();
		}

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	public show(column? : vscode.ViewColumn) {
		// If we already have a panel, show it.
		if (VenusLedMatrixUI.instance?._panel) {
			VenusLedMatrixUI.instance._panel.reveal();
		} else {
			this._addPanel(column);
		}
	}

	private _addPanel(column? : vscode.ViewColumn) {

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			VenusLedMatrixUI.viewType,
			'LED Matrix',
			column ? column : vscode.ViewColumn.Beside,
			{
				// Enable javascript in the webview
				enableScripts: true,

				// And restrict the webview to only loading content from our extension's `ledmatrix` directory.
				localResourceRoots: [vscode.Uri.file(VenusLedMatrixUI._extensionUri + '/src/ledmatrix')]
			}
		);

		this._panel = panel;

		// Set the webview's initial html content
		const webview = this._panel.webview;
		this._panel.webview.html = this._getHtmlForWebview(webview);

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'alert':
						vscode.window.showErrorMessage(message.text);
						return;
				}
			},
			null,
			this._disposables
		);
	}

	private _update() {
		this._panel?.webview.postMessage({command: "loadState", uiState: VenusLedMatrixUI._uiState})
	}

	private _getHtmlForWebview(webview: vscode.Webview, ) {

		const htmlPathOnDisk = vscode.Uri.file(VenusLedMatrixUI._extensionUri + '/src/ledmatrix/venusLedMatrixUI.html');
		var htmlpath = htmlPathOnDisk.fsPath;
		var html = fs.readFileSync(htmlpath).toString();

		const onDiskPath = vscode.Uri.file(VenusLedMatrixUI._extensionUri + '/src/ledmatrix/venusLedMatrixUI.js');
		const scriptSrc = webview.asWebviewUri(onDiskPath);
		html = html.replace('${scriptSrc}', scriptSrc.toString());

		const stylePath = vscode.Uri.file(VenusLedMatrixUI._extensionUri + '/src/ledmatrix/venusLedMatrixUI.css');
		const styleSrc = webview.asWebviewUri(stylePath);
		html = html.replace('${styleSrc}', styleSrc.toString());

		return html;
	}

	public ecall(id: number, params: any) : object {
		if (id != 0x100) return {}
		let x = (params.a1 >> 16) & 0xFFFF
		let y = params.a1 & 0xFFFF
		let red = (params.a2 >> 16) & 0xFF
		let green = (params.a2 >> 8) & 0xFF
		let blue = params.a2 & 0xFF

		var color = new Color(red, green, blue)

		VenusLedMatrixUI._uiState.getLedMatrix().setLed(x, y, color)
		if (this._panel?.visible) {
			this._panel.webview.postMessage({command: "setLed", x: x, y: y, color: color})
		}

		return {}
	}

	public resetLedMatrix() {
		VenusLedMatrixUI._uiState.getLedMatrix().resetMatrix();
		this._update();
	}
}

export class UIState {
	private ledMatrix: LedMatrix

	constructor(ledMatrix: LedMatrix){
		this.ledMatrix = ledMatrix;
	};

	public getLedMatrix(): LedMatrix {
		return this.ledMatrix
	}
}

export class LedMatrix {
	private ledState: Color[]
	readonly xCount: number
	readonly yCount: number

	setLed(x: number, y: number, color: Color) {
		if ((x + y*this.xCount) < this.ledState.length){
			this.ledState[x + y*this.xCount] = color
		}
	}

	resetMatrix() {
		this.ledState = Array<Color>(this.xCount * this.yCount).fill(new Color(0,0,0))
	}

	/** The length of the led state needs to be xSize * ySize.
	 * Otherwise the leds are initialized as all off/black.
	 */
	constructor(xSize: number, ySize: number, ledState?: Color[]){
		this.xCount = xSize;
		this.yCount = ySize;
		if (ledState == null || ledState.length != (xSize * ySize)) {
			this.resetMatrix();
		} else {
			this.ledState = ledState;
		}
	};
}

export class Color {

	readonly red: number;
	readonly green: number;
	readonly blue: number;

	constructor(red: number, green: number, blue: number) {
		this.red = (red > 255) ? 255 : red;
		this.green = (green > 255) ? 255 : green;
		this.blue = (blue > 255) ? 255 : blue;
	}
}
