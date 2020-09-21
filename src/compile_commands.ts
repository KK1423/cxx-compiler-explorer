"use strict";

import { workspace, Uri, OutputChannel } from "vscode";
import * as fs from "fs";
import * as Path from "path";
import { resolvePath, arrayEquals } from "./utils";
import * as child_process from "child_process";
import {
	JsonObject,
	JsonProperty,
	JsonConvert,
	OperationMode,
	ValueCheckingMode
} from "json2typescript";

@JsonObject("CompileCommand")
class CompileCommand {
	@JsonProperty("file", String)
	private file: string = "";

	@JsonProperty("command", String, "isOptional")
	private _command: string = "";

	@JsonProperty("arguments", [String], "isOptional")
	private _arguments: string[] = [];

	@JsonProperty("directory", String)
	directory: string = "";

	uri: Uri = Uri.file("");
	command: string = "";
	args: string[] = [""];

	process() {
		const commands = (this._command.length
			? this._command.match(/[^"\s]*("(\\"|[^"])+")?/g)!
			: this._arguments
		).filter(arg => arg.length > 0);

		this.uri = Uri.file(Path.resolve(this.directory, this.file));
		this.command = commands[0];
		this.args = this.sanitizeArgs(commands.slice(1));
	}


	getDisassembleCommand(outFile: string) {
		let args = [this.command,
			'-g1',
			'-S',
			'-masm=intel',
			'-fno-unwind-tables',
			'-fno-asynchronous-unwind-tables',
			'-fno-dwarf2-cfi-asm',
		...this.args,
			'-o',
		'"' + outFile + '"'
		];

		return this.getCommand(args);
	}

	getPreprocessCommand(outFile: string) {
		let args = [this.command, "-E", "-o", outFile].concat(this.args);

		return this.getCommand(args);
	}

	getLLVMDisassembleCommand(outFile: string) {
		let args = [
			this.command,
			"-g",
			"-S",
			"-emit-llvm",
			"-o",
			outFile
		].concat(this.args);

		return this.getCommand(args);
	}

	private getCommand(args: string[]) {
		return args.join(' ');
	}

	private sanitizeArgs(args: string[]) {
		let isOutfile = false;
		return args.filter(arg => {
			if (!isOutfile) {
				isOutfile = arg === "-o";
				return isOutfile ? false : arg !== "-c" && arg !== "-g";
			} else {
				isOutfile = false;
				return false;
			}
		});
	}
}

class CompileInfo {
	uri: Uri;
	srcUri: Uri;
	command: string;
	compilationDirectory: string;
	extraArgs: string[] = [];

	constructor(
		uri: Uri,
		srcUri: Uri,
		command: string,
		compilationDirectory: string
	) {
		this.uri = uri;
		this.srcUri = srcUri;
		this.command = command;
		this.compilationDirectory = compilationDirectory;
	}

	extraArgsChanged(extraArgs: string[]) {
		return !arrayEquals(extraArgs, this.extraArgs);
	}
}

export class CompileCommands {
	private static errorChannel: OutputChannel;
	private static compileCommands = new Map<string, CompileInfo>();
	private static asmUriMap = new Map<string, Uri>();
	private static llvmUriMap = new Map<string, Uri>();
	private static preprocessUriMap = new Map<string, Uri>();
	private static initTime: Date;
	private static outDir = resolvePath(
		workspace.getConfiguration("compilerexplorer").get<string>("outDir") +
		"/"
	);
	private static extraArgs: string[] = [];

	static setExtraCompileArgs(extraArgs: string[]) {
		this.extraArgs = extraArgs;
	}

	static getExtraCompileArgs() {
		return this.extraArgs.join(" ");
	}

	static compile(uri: Uri) {
		this.update();
		const compileInfo = this.getCompileInfo(uri);

		if (compileInfo !== undefined) {
			if (this.needCompilation(compileInfo)) {
				return this.execCompileCommand(compileInfo);
			} else {
				return true;
			}
		} else {
			return false;
		}
	}

	static getSrcUri(uri: Uri) {
		this.update();
		const compileInfo = this.compileCommands.get(uri.path);

		return compileInfo ? compileInfo.srcUri : undefined;
	}

	static getAsmUri(uri: Uri) {
		this.update();
		return this.asmUriMap.get(uri.path);
	}

	static getLLVMUri(uri: Uri) {
		this.update();
		return this.llvmUriMap.get(uri.path);
	}

	static getPreprocessUri(uri: Uri) {
		this.update();
		return this.preprocessUriMap.get(uri.path);
	}

	static init(errorChannel: OutputChannel): boolean {
		const compileCommandsFile = this.getCompileCommandsPath();

		if (fs.existsSync(compileCommandsFile)) {
			let compileCommands = this.parseCompileCommands(
				compileCommandsFile
			);

			compileCommands.forEach((compileCommand: CompileCommand) => {
				CompileCommands.processCompileCommand(compileCommand);
			});

			this.errorChannel = errorChannel;
			this.createOutputDirectory();

			this.initTime = new Date();
			return true;
		}

		return false;
	}

	static getCompileCommandsPath() {
		const compileCommandsPath =
			workspace
				.getConfiguration("compilerexplorer", null)
				.get<string>("compilationDirectory") + "/compile_commands.json";

		return compileCommandsPath
			? resolvePath(compileCommandsPath)
			: resolvePath("${workspaceFolder}/compile_commands.json");
	}

	private static update() {
		if (this.fileNewer(this.getCompileCommandsPath(), this.initTime)) {
			this.compileCommands.clear();
			this.init(this.errorChannel);
		}
	}

	private static processCompileCommand(compileCommand: CompileCommand) {
		compileCommand.process();

		const srcUri = compileCommand.uri;
		const asmUri = this.encodeAsmUri(srcUri);
		const llvmUri = this.encodeLLVMUri(srcUri);
		const preprocessUri = this.encodePreprocessUri(srcUri);

		this.asmUriMap.set(srcUri.path, asmUri);
		this.compileCommands.set(
			asmUri.path,
			new CompileInfo(
				asmUri,
				srcUri,
				compileCommand.getDisassembleCommand(asmUri.path),
				compileCommand.directory
			)
		);

		this.llvmUriMap.set(srcUri.path, llvmUri);
		this.compileCommands.set(
			llvmUri.path,
			new CompileInfo(
				llvmUri,
				srcUri,
				compileCommand.getLLVMDisassembleCommand(llvmUri.path),
				compileCommand.directory
			)
		);

		this.preprocessUriMap.set(srcUri.path, preprocessUri);
		this.compileCommands.set(
			preprocessUri.path,
			new CompileInfo(
				preprocessUri,
				srcUri,
				compileCommand.getPreprocessCommand(preprocessUri.path),
				compileCommand.directory
			)
		);
	}

	private static execCompileCommand(compileInfo: CompileInfo) {
		const command = compileInfo.command + ' ' + this.getExtraCompileArgs();
		this.errorChannel.clear();
		this.errorChannel.appendLine(command);
		const result = child_process.spawnSync(command, {
			cwd: compileInfo.compilationDirectory,
			encoding: "utf8",
			shell: true
		});

		const filtcmd = 'echo "`c++filt -t < \'' + compileInfo.uri.fsPath + '\'`" > \'' + compileInfo.uri.fsPath + '\'';
		this.errorChannel.appendLine(filtcmd);
		const filtstdout = child_process.spawnSync(filtcmd, {
			cwd: compileInfo.compilationDirectory,
			encoding: "utf8",
			shell: true
		});
		if (filtstdout.status !== null) {
			this.errorChannel.appendLine(filtstdout.status.toString());
		}

		if (result.status || result.error) { // status can be null if compiler not found
			const error = result.error
				? result.error.message
				: result.output
					? result.output.join("\n")
					: "";

			return error + "  failed with error code " +
				(result.status?.toString() || "null");
		}

		compileInfo.extraArgs = this.extraArgs;

		return true;
	}

	private static fileNewer(source: string, target: string | Date | undefined) {
		if (!target) {
			return true;
		}

		let srcStat = fs.statSync(source);

		if (target instanceof Date) {
			return srcStat.mtime > target;
		}

		let tgtStat = fs.existsSync(target) && fs.statSync(target);
		return !tgtStat || srcStat.mtime > tgtStat.mtime;
	}

	private static needCompilation(compileInfo: CompileInfo) {
		return (
			compileInfo.extraArgsChanged(this.extraArgs) ||
			this.fileNewer(compileInfo.srcUri.path, compileInfo.uri.path) ||
			this.fileNewer(this.getCompileCommandsPath(), compileInfo.uri.path)
		);
	}

	private static getCompileInfo(uri: Uri): CompileInfo | undefined {
		return this.compileCommands.get(uri.path);
	}

	private static parseCompileCommands(compileCommandsFile: string) {
		let filecontents = fs.readFileSync(compileCommandsFile);
		let jsonConvert = new JsonConvert(
			OperationMode.ENABLE,
			ValueCheckingMode.DISALLOW_NULL,
			true
		);
		let compileCommandsObj = JSON.parse(filecontents.toString());

		return jsonConvert.deserializeArray(
			compileCommandsObj,
			CompileCommand
		) as CompileCommand[];
	}

	private static createOutputDirectory() {
		if (!fs.existsSync(this.outDir)) {
			fs.mkdirSync(this.outDir);
		}
	}

	private static getUriForScheme(srcUri: Uri, scheme: string) {
		const ext = (function () {
			switch (scheme) {
				case "disassembly":
					return ".s";

				case "llvm":
					return ".ll";

				default:
					return (
						".E" +
						srcUri.path.slice(
							srcUri.path.lastIndexOf("."),
							srcUri.path.length
						)
					);
			}
		})();

		const relativePath = Path.relative(workspace.rootPath!, srcUri.path);
		const dstUri = srcUri.with({
			scheme: scheme,
			path: this.outDir + relativePath.replace(/\//g, '@') + ext
		});

		// Create Output directory if not present
		this.createOutputDirectory();

		return dstUri;
	}

	private static encodeAsmUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, "disassembly");
	}

	private static encodeLLVMUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, "llvm");
	}

	private static encodePreprocessUri(uri: Uri): Uri {
		return this.getUriForScheme(uri, uri.scheme);
	}
}
