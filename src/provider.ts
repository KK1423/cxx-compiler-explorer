"use strict";

import {
	workspace,
	Uri,
	FileSystemWatcher,
	EventEmitter,
	TextDocumentContentProvider
} from "vscode";
import { AsmDocument } from "./document";
import { CompileCommands } from "./compile_commands";
import { TypedEvent } from "./typedevent";

export class AsmProvider implements TextDocumentContentProvider {
	static scheme = "disassembly";

	private _documents = new Map<string, AsmDocument>();
	private _watchers = new Map<string, FileSystemWatcher>();
	private _onDidChange = new EventEmitter<Uri>();
	private _onDidArgChange = new TypedEvent<Uri>();

	provideTextDocumentContent(uri: Uri): string | Thenable<string> {
		let document = this.provideAsmDocument(uri);
		return document.value;
	}

	provideAsmDocument(uri: Uri): AsmDocument {
		// already loaded?
		let document = this._documents.get(uri.toString());

		if (document) {
			return document;
		}

		document = new AsmDocument(uri);
		this._documents.set(uri.toString(), document);

		// Watch for src file and reload it on change
		this.addWatcherForURI(CompileCommands.getSrcUri(uri)!, uri);
		this.addWatcherForURI(Uri.file(CompileCommands.getCompileCommandsPath()), uri);

		return document;
	}

	private addWatcherForURI(uri: Uri, asm: Uri) {
		const watcher = workspace.createFileSystemWatcher(
			uri!.path
		);

		watcher.onDidChange(fileUri =>
			this.reloadAsmDocument(asm)
		);
		watcher.onDidCreate(fileUri =>
			this.reloadAsmDocument(asm)
		);
		watcher.onDidDelete(fileUri =>
			this.reloadAsmDocument(asm)
		);
		this._watchers.set(uri.toString() + asm.toString(), watcher);
		this._onDidArgChange.on(asmUri => this.reloadAsmDocument(asmUri));
	}

	reloadAsmDocument(fileUri: Uri) {
		const uri = fileUri.with({ scheme: AsmProvider.scheme });
		const document = new AsmDocument(uri);

		this._documents.set(uri.toString(), document);
		this._onDidChange.fire(uri);
	}

	notifyCompileArgsChange(asmUri: Uri) {
		this._onDidArgChange.emit(asmUri);
	}

	// Expose an event to signal changes of _virtual_ documents
	// to the editor
	get onDidChange() {
		return this._onDidChange.event;
	}

	dispose() {
		this._watchers.forEach(watcher => watcher.dispose());
		this._documents.clear();
		this._onDidChange.dispose();
	}
}
