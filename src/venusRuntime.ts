/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import simulator = require('./runtime/riscvSimulator');
import range from 'lodash/range';
import { VenusRenderer } from './venusRenderer';
import { MemoryUI } from './memoryui/memoryUI';
import { AssemblyLineInfo } from './assemblyView';
import { StackFrame } from 'vscode-debugadapter';
import { resolve } from 'path';
import { clearTimeout } from 'timers';

export interface VenusBreakpoint {
	id: number;
	line: number;
	verified: boolean;
	path: string;
}

export interface Register {
	id: number;
	value: number;
}

/**
 * This interface holds the data that a AssemblyLine contains
 */
export interface AssemblyLine {
	pc: number;
    mCode: number;
	basicCode: string;
	assemblyViewLine: number;
	sourcePath: string;
	sourceLine: number;
}

export interface CallStackItem {
	index: number;
	name: string;
	file: string;
	line: number;
}

/**
 * This Runtime communicates between vscode and the venus Simulator
 */
export class VenusRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	// This stack keeps track of the functions we jumped from
	private _functionStack = new Array<CallStackItem>();

	// the contents (= lines) of the one and only file
	private _sourceLines: string[];

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, VenusBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	constructor() {
		super();
		simulator.driver.setBreakBeforeInstruction(true);
	}

	private _stopAtBreakpoint = true;

	private sourceLine_to_pc: Map<string, number[]> = new Map<string, number[]>();
	private pc_to_assemblyLine: Map<number, AssemblyLine> = new Map<number, AssemblyLine>();

	/**
	 * Start executing the given program.
	 */
	public start(stopOnEntry: boolean) {
		if (stopOnEntry) {
			this.updateStack();
			this.sendEvent('stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.run();
		}
	}

	public assemble(fpath: string, fName: string) {
		try {
			let text: string = readFileSync(fpath).toString();
			var[success, error, warnings] = simulator.driver.externalAssemble(text, fpath, fName); // TODO usually Renderer fires a popup on error (e.g. malformed instruction) that something went wrong
			if (!success) {
				VenusRenderer.getInstance().showErrorWithPopup(error);
				this.sendEvent("end");
				return;
			}
			for (let warn in warnings.toArray()) {
				VenusRenderer.getInstance().printWarning(warn);
			}

			this.getAssemblyLines();
		} catch (e: unknown) {
			VenusRenderer.getInstance().showErrorWithPopup(e);
			this.sendEvent('end')
		}
	}

	private getAssemblyLines(){
		this.pc_to_assemblyLine.clear();
		this.sourceLine_to_pc.clear()
		let instructions = simulator.driver.getInstructions();

		for (let i = 0; i < instructions.length; i++) {
			let assemblyLine: AssemblyLine = {pc: instructions[i].pc, mCode: instructions[i].mcode, basicCode: instructions[i].basicCode, assemblyViewLine: 0, sourceLine: instructions[i].line, sourcePath: instructions[i].sourceFile};
			this.pc_to_assemblyLine.set(instructions[i].pc, assemblyLine);
			let sourceIdent = this.createSourcelineString(instructions[i].sourceFile, instructions[i].line);
			if (this.sourceLine_to_pc.has(sourceIdent)) {
				this.sourceLine_to_pc.get(sourceIdent)!.push(instructions[i].pc);
			} else {
				this.sourceLine_to_pc.set(sourceIdent, [instructions[i].pc]);
			}
		}

	}

	/** Creates a sourceLine identifier for debugging: C://exampledir/example.file:5 5 == linenumber */
	private createSourcelineString(path: string, line: number): string {
		return path + ':' + Math.round(line).toString();
	}

	public getPcToAssemblyLine(): Map<number, AssemblyLine> {
		return this.pc_to_assemblyLine
	}

	public getCurrentAssemlyLineNo(): number {
		if (this.pc_to_assemblyLine.has(simulator.driver.sim.getPC())) {
			return this.pc_to_assemblyLine.get(simulator.driver.sim.getPC())!.assemblyViewLine
		} else {
			return 0
		}
	}

	public getPC(): number {
		return simulator.driver.sim.getPC();
	}

	/**
	 * Returns the common registers
	 * No float registeres included
	 */
	public getRegisters(): Register[] {
		return range(0,32).map(id => {
			return {
				id,
				value: simulator.driver.getRegister(id)
			}
		})
	}

	public getRegister(id: number): Register {
		return {
			id,
			value: simulator.driver.getRegister(id)
		}
	}

	/**
	 * Returns the float registers
	 */
	public getFRegisters() {
		return range(0,32).map(id => {
			return {
				id,
				value: simulator.driver.getFRegister(id)
			}
		})
	}

	public getFRegister(id: number): Register {
		return {
			id,
			value: simulator.driver.getFRegister(id)
		}
	}

	/**
	 * Sets a int Register in the simulator
	 * @param reg The register with value
	 */
	public setRegister(id: number, value: number) {
		if (Number.isInteger(id) && Number.isInteger(value)) {
			simulator.driver.setRegister(id, value)
		}
	}

	/**
	 * Sets a float Register in the simulator.
	 * Make sure the register value is float.
	 * @param reg The register with value
	 */
	public setFRegister(id: number, value: number) {
		if (Number.isInteger(id) && !Number.isInteger(value)) {
			simulator.driver.setFRegister(id, value)
		}
	}

	/**
	 * Sets if the runtime should stop at Breakpoints
	 * @param value If true the runtime stops at Breakpoints
	 */
	public setStopAtBreakpoint(value: boolean) {
		this._stopAtBreakpoint = value
	}

	// MOCK RUNTIME DEFINED METHODS


	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false) {
		if (reverse) {
			simulator.driver.undo()
		} else {
			simulator.driver.step()
			this.updateStack()
		}
		this.updateMemory()
		if (simulator.driver.isFinished()) {
			this.sendEvent('end')
		} else {
			this.sendEvent('stopOnStep')
		}
	}

	public stepOver() {
		const stackDepth = this._functionStack.length;
		do {
			simulator.driver.step()
			this.updateStack()
		} while (stackDepth < this._functionStack.length);
		this.updateMemory()
		if (simulator.driver.isFinished()) {
			this.sendEvent('end')
		} else {
			this.sendEvent('stopOnStep')
		}
	}

	public stepOut() {
		const desiredStackDepth = this._functionStack.length - 1;
		if (desiredStackDepth <= 0) {
			this.run()
		} else {
			while (desiredStackDepth < this._functionStack.length) {
				simulator.driver.step()
				this.updateStack()
			}
			this.updateMemory()
			if (simulator.driver.isFinished()) {
				this.sendEvent('end')
			} else {
				this.sendEvent('stopOnStep')
			}
		}
	}

	static readonly TIMEOUT_TIME = 10
	static readonly TIMEOUT_CYCLES = 100

	public run() {
        if (simulator.driver.timer != null) {
            this.runEnd()
        } else {
            try {
                //simulator.driver.Renderer.setRunButtonSpinning(true)
                simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime.TIMEOUT_TIME, this._stopAtBreakpoint)
                this.runStep() // walk past breakpoint
            } catch (e) {
                this.runEnd()
                simulator.driver.handleError("RunStart", e)
            }
        }
    }

	private runStart(useBreakPoints: Boolean) {
        try {
            var cycles = 0
            while (cycles < VenusRuntime.TIMEOUT_CYCLES) {
                if (simulator.driver.sim.isDone() || (simulator.driver.sim.atBreakpoint() && useBreakPoints)) {
                    simulator.driver.exitcodecheck()
                    this.runEnd()
                    //simulator.driver.Renderer.updateAll()
                    return
                }

                simulator.driver.handleNotExitOver()
                this.runStep()
                //Renderer.updateCache(Address(0, MemSize.WORD))
                cycles++
            }

            simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime.TIMEOUT_TIME, useBreakPoints)
        } catch (e) {
            this.runEnd()
            simulator.driver.handleError("RunStart", e)
        }
    }

    private runEnd() {
        simulator.driver.handleNotExitOver()
		clearTimeout(simulator.driver.timer)

		simulator.driver.timer = null
		this.updateMemory()
		if (simulator.driver.sim.isDone()) {
			this.sendEvent('end')
		} else if (simulator.driver.sim.atBreakpoint()) {
			this.sendEvent('stopOnBreakpoint')
		} else {
			this.sendEvent('stopOnStep')
		}
	}

	private runStep() {
		simulator.driver.sim.step()
		this.updateStack()
	}

	private updateStack() {
		const jumpRegex = new RegExp("jalr?\\sx1")

		let instInfo = simulator.driver.getCurrentInstruction()

		var assemblyLine: AssemblyLine = {pc: instInfo.pc, mCode: instInfo.mcode, basicCode: instInfo.basicCode, assemblyViewLine: 0, sourceLine: 0, sourcePath: "unkown"};

		let pc = simulator.driver.sim.getPC();
		let instruction = this.pc_to_assemblyLine.get(pc);
		if (instruction != null) {
			assemblyLine.assemblyViewLine = instruction.assemblyViewLine
			assemblyLine.sourceLine = instruction.sourceLine
			assemblyLine.sourcePath = instruction.sourcePath
		}
		const lineadditive = 0;


		if (assemblyLine != null) {
			const lineContent = assemblyLine.basicCode

			if (this._functionStack.length > 0 && this._functionStack[0].name.startsWith("jalr x0")) {
				this._functionStack.shift()
				this._functionStack.shift()
			} else if (this._functionStack.length > 0 && jumpRegex.test(this._functionStack[0].name)) {
				// if there is a jump we keep the jump on the stack
			} else {
				this._functionStack.shift()
			}

			this._functionStack.unshift({
					index: 0,
					name: lineContent,
					file: assemblyLine.sourcePath,
					line: assemblyLine.sourceLine + lineadditive // the top element on the stack defines the highlighted line in the editor!!!
				});

		}
	}

	/**
	 * Returns a stacktrace which is build at each execution step. This function just returns it.
	 */
	public stack(startFrame: number, endFrame: number): any {

		return {
			frames: this._functionStack.slice(0,1),
			count: this._functionStack.length
		};

	}

	/** TODO: This is used by the BreakPoint Location Request but we don't use that right now.
	 * If we decide to use this fuction we need to rewrite it.
	 */
	public getBreakpoints(path: string, line: number): number[] {

		const l = this._sourceLines[line];

		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			} else {
				sawSpace = true;
			}
		}

		return bps;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : VenusBreakpoint {

		const bp = <VenusBreakpoint> { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<VenusBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path);

		this.toggleBreakpoint(path, bp.line)

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : VenusBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		const bps = this._breakPoints.get(path);
		if (bps) {
			bps.forEach(bp => this.toggleBreakpoint(path, bp.line));
		}
		this._breakPoints.delete(path);
	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	// private methods

	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}

	private verifyBreakpoints(path: string) : void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			let sourceLines = readFileSync(path).toString().split('\n');
			bps.forEach(bp => {
				if (!bp.verified && bp.line < sourceLines.length) {
					const srcLine = sourceLines[bp.line].trim();

					let pc = this.sourceLine_to_pc.get(this.createSourcelineString(path, bp.line));
					if (pc == null) {
						bp.verified = false;
					} else {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}

				}
			});
		}
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, stepEvent?: string): boolean {

		const line = this._sourceLines[ln].trim();

		// if 'log(...)' found in source -> send argument to debug console
		const matches = /log\((.*)\)/.exec(line);
		if (matches && matches.length === 2) {
			this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
		}

		// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
		const words = line.split(" ");
		for (let word of words) {
			if (this._breakAddresses.has(word)) {
				this.sendEvent('stopOnDataBreakpoint');
				return true;
			}
		}

		// if word 'exception' found in source -> throw exception
		if (line.indexOf('exception') >= 0) {
			this.sendEvent('stopOnException');
			return true;
		}

		// is there a breakpoint?
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				// send 'stopped' event
				this.sendEvent('stopOnBreakpoint');

				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent('breakpointValidated', bps[0]);
				}
				return true;
			}
		}

		// non-empty line
		if (stepEvent && line.length > 0) {
			this.sendEvent(stepEvent);
			return true;
		}

		// nothing interesting found -> continue
		return false;
	}

	private toggleBreakpoint(path: string, line: number) {
		let pc = this.sourceLine_to_pc.get(this.createSourcelineString(path, line))
		if (pc != null) {
			pc.forEach(progcounter => {
				simulator.driver.toggleBreakpoint(progcounter);
			});
		}
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	public static registerECallReceiver(func: (json: string) => void) {
		simulator.driver.registerECallReceiver(func);
	}

	private updateMemory() {
		MemoryUI.getInstance().update()
	}

}
