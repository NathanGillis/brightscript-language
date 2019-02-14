import { BrsFile } from './files/BrsFile';
import { XmlFile } from './files/XmlFile';
import { Diagnostic, Callable, File, CallableContainer } from './interfaces';
import { EventEmitter } from 'events';
import util from './util';
import { diagnosticMessages } from './DiagnosticMessages';
import { CompletionItem, CompletionItemKind, MarkupContent, Range } from 'vscode-languageserver';
import { Program } from './Program';

/**
 * A class to keep track of all declarations within a given context (like global scope, component scope)
 */
export class Context {
    constructor(
        public name: string,
        private matcher: (file: File) => boolean | void
    ) {
    }

    /**
     * Indicates whether this context needs to be validated. 
     * Will be true when first constructed, or anytime one of its watched files is added, changed, or removed
     */
    public isValidated = true;

    protected program: Program;

    protected programHandles = [] as (() => void)[];

    /**
     * Attach the context to a program. This allows the context to monitor file adds, changes, and removals, and respond accordingly
     * @param program 
     */
    public attachProgram(program: Program) {
        this.program = program;
        this.programHandles = [
            program.on('file-added', (file) => {
                if (this.matcher(file)) {
                    this.addOrReplaceFile(file);
                }
            }),

            program.on('file-removed', (file) => {
                if (this.hasFile(file)) {
                    this.removeFile(file);
                }
            })
        ];

        //add any current matches
        for (let filePath in program.files) {
            let file = program.files[filePath];
            if (this.matcher(file)) {
                this.addOrReplaceFile(file);
            }
        }
    }

    /**
     * Clean up all event handles
     */
    public dispose() {
        for (let disconnect of this.programHandles) {
            disconnect();
        }
        this.detachParent();
    }

    private parentContextHandles = [] as (() => void)[];

    public attachParentContext(parent: Context) {
        this.parentContext = parent;
        this.parentContextHandles = [
            //whenever the parent is marked dirty, mark ourself as dirty
            parent.on('invalidated', () => {
                this.isValidated = false;
            })
        ];

        //immediately invalidate self if parent is not validated
        if (!this.parentContext.isValidated) {
            this.isValidated = false;
        }
    }

    public detachParent() {
        for (let disconnect of this.parentContextHandles) {
            disconnect();
        }
        this.parentContext = this.program.platformContext;
    }

    /**
     * A parent context that this context inherits all things from.
     */
    public parentContext: Context;

    /**
     * Determine if this file should 
     * @param filePath 
     */
    public shouldIncludeFile(file: File) {
        return this.matcher(file) === true ? true : false;
    }

    public files = {} as { [filePath: string]: ContextFile };

    /**
     * Get the list of errors for this context. It's calculated on the fly, so
     * call this sparingly.
     */
    public getDiagnostics(): Diagnostic[] {
        let diagnosticLists = [this._diagnostics] as Diagnostic[][];
        //add diagnostics from every referenced file
        for (let filePath in this.files) {
            let ctxFile = this.files[filePath];
            diagnosticLists.push(ctxFile.file.getDiagnostics());
        }
        let result = Array.prototype.concat.apply([], diagnosticLists);
        return result;
    }

    /**
     * The list of diagnostics found specifically for this context. Individual file diagnostics are stored on the files themselves.
     */
    protected _diagnostics = [] as Diagnostic[];

    /**
     * Get the list of callables available in this context (either declared in this context or in a parent context) 
     */
    public getAllCallables(): CallableContainer[] {
        //get callables from parent contexts
        if (this.parentContext) {
            return [...this.getOwnCallables(), ...this.parentContext.getAllCallables()];
        } else {
            return [...this.getOwnCallables()];
        }
    }

    /**
     * Get the list of callables explicitly defined in files in this context.
     * This excludes ancestor callables
     */
    public getOwnCallables(): CallableContainer[] {
        let result = [] as CallableContainer[];

        //get callables from own files
        for (let filePath in this.files) {
            let file = this.files[filePath];
            for (let callable of file.file.callables) {
                result.push({
                    callable: callable,
                    context: this
                });
            }
        }
        return result;
    }

    public emitter = new EventEmitter();

    public on(eventName: 'invalidated', callback: () => void);
    public on(eventName: string, callback: (data: any) => void) {
        this.emitter.on(eventName, callback);
        return () => {
            this.emitter.removeListener(eventName, callback);
        }
    }

    protected emit(name: 'invalidated');
    protected emit(name: string, data?: any) {
        this.emitter.emit(name, data);
    }

    /**
     * Add a file to the program.
     * @param filePath 
     * @param fileContents 
     */
    public addOrReplaceFile(file: BrsFile | XmlFile) {
        this.isValidated = false;

        //if the file is already loaded, remove it first
        if (this.files[file.pathAbsolute]) {
            this.removeFile(file);
        }

        let ctxFile = new ContextFile(file);

        //keep a reference to this file
        this.files[file.pathAbsolute] = ctxFile;
    }

    /**
     * Remove the file from this context. 
     * If the file doesn't exist, the method exits immediately, but does not throw an error.
     * @param file
     * @param emitRemovedEvent - if false, the 'remove-file' event will not be emitted
     */
    public removeFile(file: File) {
        this.isValidated = false;

        let ctxFile = this.files[file.pathAbsolute];
        if (!ctxFile) {
            return;
        }

        //remove the reference to this file
        delete this.files[file.pathAbsolute];
        this.emit('invalidated');
    }

    public validate() {
        //if this context is already validated, no need to revalidate
        if (this.isValidated === true) {
            return;
        }
        //validate our parent before we validate ourself
        if (this.parentContext && this.parentContext.isValidated === false) {
            this.parentContext.validate();
        }
        //clear the context's errors list (we will populate them from this method)
        this._diagnostics = [];

        let callables = this.getAllCallables();

        //sort the callables by filepath and then method name, so the errors will be consistent
        callables = callables.sort((a, b) => {
            return (
                //sort by path
                a.callable.file.pathAbsolute.localeCompare(b.callable.file.pathAbsolute) ||
                //then sort by method name
                a.callable.name.localeCompare(b.callable.name)
            );
        });

        //get a list of all callables, indexed by their lower case names
        let callableContainersByLowerName = util.getCallableContainersByLowerName(callables);

        //find all duplicate function declarations
        this.diagnosticFindDuplicateFunctionDeclarations(callableContainersByLowerName);

        //do many per-file checks
        for (let key in this.files) {
            let contextFile = this.files[key];
            this.diagnosticDetectCallsToUnknownFunctions(contextFile.file, callableContainersByLowerName);
            this.diagnosticDetectFunctionCallsWithWrongParamCount(contextFile.file, callableContainersByLowerName);
        }

        this.isValidated = false;
    }

    /**
     * Detect calls to functions with the incorrect number of parameters
     * @param file 
     * @param callableContainersByLowerName 
     */
    private diagnosticDetectFunctionCallsWithWrongParamCount(file: BrsFile | XmlFile, callableContainersByLowerName: { [lowerName: string]: CallableContainer[] }) {
        //validate all expression calls
        for (let expCall of file.expressionCalls) {
            let callableContainersWithThisName = callableContainersByLowerName[expCall.name.toLowerCase()];

            //use the first item from callablesByLowerName, because if there are more, that's a separate error
            let knownCallableContainer = callableContainersWithThisName ? callableContainersWithThisName[0] : undefined;

            if (knownCallableContainer) {
                //get min/max parameter count for callable
                let minParams = 0;
                let maxParams = 0;
                for (let param of knownCallableContainer.callable.params) {
                    maxParams++;
                    //optional parameters must come last, so we can assume that minParams won't increase once we hit
                    //the first isOptional
                    if (param.isOptional === false) {
                        minParams++;
                    }
                }
                let expCallArgCount = expCall.args.length;
                if (expCall.args.length > maxParams || expCall.args.length < minParams) {
                    let minMaxParamsText = minParams === maxParams ? maxParams : minParams + '-' + maxParams;
                    this._diagnostics.push({
                        message: util.stringFormat(diagnosticMessages.Expected_a_arguments_but_got_b_1002.message, minMaxParamsText, expCallArgCount),
                        code: diagnosticMessages.Expected_a_arguments_but_got_b_1002.code,
                        location: Range.create(
                            expCall.lineIndex,
                            expCall.columnIndexBegin,
                            expCall.lineIndex,
                            Number.MAX_VALUE
                        ),
                        //TODO detect end of expression call
                        file: file,
                        severity: 'error'
                    });
                }
            }
        }
    }

    /**
     * Detect calls to functions that are not defined in this context
     * @param file 
     * @param callablesByLowerName 
     */
    private diagnosticDetectCallsToUnknownFunctions(file: BrsFile | XmlFile, callablesByLowerName: { [lowerName: string]: CallableContainer[] }) {
        //validate all expression calls
        for (let expCall of file.expressionCalls) {
            let callablesWithThisName = callablesByLowerName[expCall.name.toLowerCase()];

            //use the first item from callablesByLowerName, because if there are more, that's a separate error
            let knownCallable = callablesWithThisName ? callablesWithThisName[0] : undefined;

            //detect calls to unknown functions
            if (!knownCallable) {
                this._diagnostics.push({
                    message: util.stringFormat(diagnosticMessages.Call_to_unknown_function_1001.message, expCall.name),
                    code: diagnosticMessages.Call_to_unknown_function_1001.code,
                    location: Range.create(
                        expCall.lineIndex,
                        expCall.columnIndexBegin,
                        expCall.lineIndex,
                        expCall.columnIndexEnd
                    ),
                    file: file,
                    severity: 'error'
                });
                continue;
            }
        }
    }


    /**
     * Create diagnostics for any duplicate function declarations
     * @param callablesByLowerName 
     */
    private diagnosticFindDuplicateFunctionDeclarations(callableContainersByLowerName: { [lowerName: string]: CallableContainer[] }) {
        //for each list of callables with the same name
        for (let lowerName in callableContainersByLowerName) {
            let callableContainers = callableContainersByLowerName[lowerName];

            let platformCallables = [] as CallableContainer[];
            let nonPlatformCallables = [] as CallableContainer[];
            let ownCallables = [] as CallableContainer[];
            let ancestorNonPlatformCallables = [] as CallableContainer[];

            for (let container of callableContainers) {
                if (container.context === this.program.platformContext) {
                    platformCallables.push(container);
                } else {
                    nonPlatformCallables.push(container);
                    if (container.context === this) {
                        ownCallables.push(container);
                    } else {
                        ancestorNonPlatformCallables.push(container);
                    }
                }
            }

            //add info diagnostics about child shadowing parent functions
            if (ownCallables.length > 0 && ancestorNonPlatformCallables.length > 0) {
                inner: for (let container of ownCallables) {
                    //skip the init function (because every component will have one of those){
                    if (lowerName === 'init') {
                        continue inner;
                    }
                    let shadowedCallable = ancestorNonPlatformCallables[ancestorNonPlatformCallables.length - 1];
                    this._diagnostics.push({
                        message: util.stringFormat(
                            diagnosticMessages.Shadows_ancestor_function_1010.message,
                            container.callable.name,
                            container.context.name,
                            shadowedCallable.callable.file.pkgPath,
                            //grab the last item in the list, which should be the closest ancestor's version
                            shadowedCallable.context.name,
                        ),
                        code: diagnosticMessages.Shadows_ancestor_function_1010.code,
                        location: container.callable.nameRange,
                        file: container.callable.file,
                        severity: 'hint'
                    });
                }
            }

            //add error diagnostics about duplicate functions in the same context
            if (ownCallables.length > 1) {

                for (let callableContainer of ownCallables) {
                    let callable = callableContainer.callable;

                    this._diagnostics.push({
                        message: util.stringFormat(diagnosticMessages.Duplicate_function_implementation_1003.message, callable.name, callableContainer.context.name),
                        code: diagnosticMessages.Duplicate_function_implementation_1003.code,
                        location: Range.create(
                            callable.nameRange.start.line,
                            callable.nameRange.start.character,
                            callable.nameRange.start.line,
                            callable.nameRange.end.character
                        ),
                        file: callable.file,
                        severity: 'error'
                    });
                }
            }
        }
    }

    /**
     * Find the file with the specified relative path
     * @param relativePath 
     */
    protected getFileByRelativePath(relativePath: string) {
        for (let key in this.files) {
            if (this.files[key].file.pkgPath === relativePath) {
                return this.files[key];
            }
        }
    }

    /**
     * Determine if the context already has this file in its files list
     * @param file 
     */
    public hasFile(file: BrsFile | XmlFile) {
        if (this.files[file.pathAbsolute]) {
            return true;
        } else {
            return false;
        }
    }

    /**
     * Get all callables as completionItems
     */
    public getCallablesAsCompletions() {
        let completions = [] as CompletionItem[];
        let callables = this.getAllCallables();
        for (let callableContainer of callables) {
            completions.push({
                label: callableContainer.callable.name,
                kind: CompletionItemKind.Function,
                detail: callableContainer.callable.shortDescription,
                documentation: callableContainer.callable.documentation ? { kind: 'markdown', value: callableContainer.callable.documentation } : undefined
            });
        }
        return completions;
    }
}

class ContextFile {
    constructor(
        public file: BrsFile | XmlFile
    ) {
    }
}