import * as vscode from 'vscode'
import fs from 'fs'
import { TheiaCompatibleVscodeUri } from '../theia/polyfill';

/**
 * Manages cat coding webview panels
 */
export class VenusRobotUI {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static instance: VenusRobotUI | undefined;

	public static readonly viewType = 'VenusRobotUI';
	private _panel: vscode.WebviewPanel;
	private static _extensionUri: TheiaCompatibleVscodeUri;
	private _disposables: vscode.Disposable[] = [];
	private static _uiState: UIState;


	public static getInstance(): VenusRobotUI {
		if (VenusRobotUI.instance) {
			return VenusRobotUI.instance
		} else {
			VenusRobotUI.instance = new VenusRobotUI(undefined, VenusRobotUI._uiState)
			return VenusRobotUI.instance
		}
	}

	/** Closes the old instance if available and opens a new one */
	public static createNewInstance(extensionUri: TheiaCompatibleVscodeUri, uiState?: UIState): VenusRobotUI {
		if (VenusRobotUI.instance) {
			VenusRobotUI.instance.dispose();
		}
		VenusRobotUI.instance = new VenusRobotUI(extensionUri, uiState)
		return VenusRobotUI.instance
	}

	private constructor(extensionUri?: TheiaCompatibleVscodeUri, uiState?: UIState) {
		if (extensionUri)
			VenusRobotUI._extensionUri = extensionUri
		if (uiState) {
			VenusRobotUI._uiState = uiState;
		} else {
			VenusRobotUI._uiState = new UIState(new LedMatrix())
		}
	}

	public dispose() {
		VenusRobotUI.instance = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	public show(column? : vscode.ViewColumn) {
		// If we already have a panel, show it.
		if (VenusRobotUI.instance?._panel) {
			VenusRobotUI.instance._panel.reveal();
		} else {
			this._addPanel();
		}
	}

	private _addPanel(column? : vscode.ViewColumn) {

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			VenusRobotUI.viewType,
			'Robot',
			column ? column : vscode.ViewColumn.Beside,
			{
				// Enable javascript in the webview
				enableScripts: true,

				// And restrict the webview to only loading content from our extension's `ui` directory.
				localResourceRoots: [vscode.Uri.file(VenusRobotUI._extensionUri +  '/src/robot')]
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
		this._panel?.webview.postMessage({command: "loadState", uiState: VenusRobotUI._uiState})
	}

	private _getHtmlForWebview(webview: vscode.Webview, ) {

		const htmlPathOnDisk = vscode.Uri.file(VenusRobotUI._extensionUri + '/src/robot/venusRobotUI.html');
		var htmlpath = htmlPathOnDisk.fsPath;
		var html = fs.readFileSync(htmlpath).toString();

		const onDiskPath = vscode.Uri.file(VenusRobotUI._extensionUri + '/src/robot/venusRobotUI.js');
		const scriptSrc = webview.asWebviewUri(onDiskPath);
		html = html.replace('${scriptSrc}', scriptSrc.toString());

		const stylePath = vscode.Uri.file(VenusRobotUI._extensionUri + '/src/robot/venusRobotUI.css');
		const styleSrc = webview.asWebviewUri(stylePath);
		html = html.replace('${styleSrc}', styleSrc.toString());

		return html;
	}

	public ecall(id : number, params : any) : object {
		if (id != 0x110) return {};
		let row : number = params.a1;
		let values : number = params.a2;
		VenusRobotUI._uiState.getLedMatrix().setLedRow(row, values)
		if (this._panel?.visible) {
			this._panel.webview.postMessage({command: "setLedRow", row: row, values: values})
		}
		return {}
	}

	public resetLedMatrix() {
		VenusRobotUI._uiState.getLedMatrix().resetMatrix()
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
	private ledState : number[]
	private rows : number = 12

	setLedRow(row: number, values: number) {
		if (row < this.rows){
			this.ledState[row] = values
		}
	}

	resetMatrix() {
		this.ledState = Array<number>(this.rows).fill(0)
	}

	constructor(ledState?: number[]){
		if (ledState == null || ledState.length == this.rows) {
			this.resetMatrix();
		} else {
			this.ledState = ledState;
		}
	};
}
