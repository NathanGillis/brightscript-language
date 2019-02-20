import chalk from 'chalk';
import * as path from 'path';
import * as rokuDeploy from 'roku-deploy';
import * as debounce from 'debounce-promise';
import Uri from 'vscode-uri';

import util from './util';
import { Watcher } from './Watcher';
import { Program } from './Program';
import { FileObj, Diagnostic } from './interfaces';
import { FileEvent, FileChangeType } from 'vscode-languageserver';

/**
 * A runner class that handles
 */
export class ProgramBuilder {
    constructor(
    ) {
    }

    private options: BRSConfig;
    private isRunning = false;
    private watcher: Watcher;
    public program: Program;

    /**
     * The list of errors found in the program.
     */
    private getDiagnostics() {
        return this.program.getDiagnostics();
    }

    public async run(options: BRSConfig) {
        if (this.isRunning) {
            throw new Error('Server is already running');
        }
        this.options = await util.normalizeAndResolveConfig(options);

        this.program = new Program(this.options);
        //parse every file in the entire project
        await this.loadAllFilesAST();

        if (this.options.watch) {
            util.log('Starting compilation in watch mode...');
            await this.runOnce();
            await this.enableWatchMode();
        } else {
            await this.runOnce();
        }
    }

    public async enableWatchMode() {
        this.watcher = new Watcher(this.options);
        //keep the process alive indefinitely by setting an interval that runs once every 12 days
        setInterval(() => { }, 1 << 30);

        //clear the console
        util.clearConsole();

        let fileObjects = rokuDeploy.normalizeFilesOption(this.options.files ? this.options.files : []);

        //add each set of files to the file watcher
        for (let fileObject of fileObjects) {
            this.watcher.watch(fileObject.src);
        }

        util.log('Watching for file changes...');

        let debouncedRunOnce = debounce(async () => {
            util.log('File change detected. Starting incremental compilation...');
            await this.runOnce();
            let errorCount = this.getDiagnostics().length;
            util.log(`Found ${errorCount} errors. Watching for file changes.`);
        }, 50);
        //on any file watcher event
        this.watcher.on('all', (event: string, path: string) => {
            // console.log(event, path);
            if (event === 'add' || event === 'change') {
                this.program.addOrReplaceFile(path);
            } else if (event === 'unlink') {
                this.program.removeFile(path);
            }
            //wait for change events to settle, and then execute `run`
            debouncedRunOnce();
        });
    }

    /**
     * A method that is used to cancel a previous run task.
     * Does nothing if previous run has completed or was already canceled
     */
    private cancelLastRun = () => { return Promise.resolve(); };

    /**
     * Run the entire process exactly one time.
     */
    private runOnce() {
        //clear the console
        util.clearConsole();
        let cancellationToken = { isCanceled: false };
        let isCompleted = false;
        //wait for the previous run to complete
        let runPromise = this.cancelLastRun().then(() => {
            //start the new run
            return this._runOnce(cancellationToken);
        }).then(() => {
            this.printDiagnostics();
            //track if the run completed
            isCompleted = true;
        }, async (err) => {
            await this.printDiagnostics();
            //track if the run completed
            isCompleted = true;
            throw err;
        });

        //a function used to cancel this run
        this.cancelLastRun = () => {
            cancellationToken.isCanceled = true;
            return runPromise;
        };
        return runPromise;
    }

    private async printDiagnostics() {
        let diagnostics = this.getDiagnostics();

        //group the diagnostics by file
        let diagnosticsByFile = {} as { [pathAbsolute: string]: Diagnostic[] };
        for (let diagnostic of diagnostics) {
            if (!diagnosticsByFile[diagnostic.file.pathAbsolute]) {
                diagnosticsByFile[diagnostic.file.pathAbsolute] = [];
            }
            diagnosticsByFile[diagnostic.file.pathAbsolute].push(diagnostic);
        }

        let cwd = this.options.cwd ? this.options.cwd : process.cwd();

        let pathsAbsolute = Object.keys(diagnosticsByFile).sort();
        for (let pathAbsolute of pathsAbsolute) {
            let diagnosticsForFile = diagnosticsByFile[pathAbsolute];
            //sort the diagnostics in line and column order
            let sortedDiagnostics = diagnosticsForFile.sort((a, b) => {
                return (
                    a.location.start.line - b.location.start.line ||
                    a.location.start.character - b.location.start.character
                );
            });
            let filePath = pathAbsolute;
            let typeColor = {
                information: chalk.blue,
                hint: chalk.green,
                warning: chalk.yellow,
                error: chalk.red,

            };
            if (this.options.emitFullPaths !== true) {
                filePath = path.relative(cwd, filePath);
            }
            //load the file text
            let fileText = await util.getFileContents(pathAbsolute);
            //split the file on newline
            let lines = util.getLines(fileText);
            for (let diagnostic of sortedDiagnostics) {
                console.log('');
                console.log(
                    chalk.cyan(filePath) +
                    ':' +
                    chalk.yellow(
                        (diagnostic.location.start.line + 1) +
                        ':' +
                        (diagnostic.location.start.character + 1)
                    ) +
                    ' - ' +
                    typeColor[diagnostic.severity](diagnostic.severity) +
                    ' ' +
                    chalk.grey('BRS' + diagnostic.code) +
                    ': ' +
                    chalk.white(diagnostic.message)
                );
                console.log('');

                //print the line
                let diagnosticLine = lines[diagnostic.location.start.line];

                //if the squiggly length is longer than the line, concat to end of line
                var squigglyLength = diagnostic.location.end.character - diagnostic.location.start.character;
                if (squigglyLength > diagnosticLine.length - diagnostic.location.start.character) {
                    squigglyLength = diagnosticLine.length - diagnostic.location.end.character;
                }
                let lineNumberText = chalk.bgWhite(' ' + chalk.black((diagnostic.location.start.line + 1).toString()) + ' ') + ' ';
                console.log(lineNumberText + diagnosticLine);
                console.log(lineNumberText +
                    typeColor[diagnostic.severity](
                        util.padLeft('', diagnostic.location.start.character, ' ') +
                        //print squigglies 
                        util.padLeft('', squigglyLength, '~')
                    )
                );
                console.log('');
            }
        }
    }

    /**
     * Run the process once, allowing cancelability.
     * NOTE: This should only be called by `runOnce`.
     * @param cancellationToken
     */
    private async _runOnce(cancellationToken: { isCanceled: any }) {
        //maybe cancel?
        if (cancellationToken.isCanceled === true) { return -1; }

        //validate program
        await this.validateProject();

        let errorCount = this.getDiagnostics().length;

        //maybe cancel?
        if (cancellationToken.isCanceled === true) { return -1; }

        if (errorCount > 0) {
            return errorCount;
        }

        //create the deployment package
        await this.createPackageIfEnabled();

        //maybe cancel?
        if (cancellationToken.isCanceled === true) { return -1; }

        //deploy the package
        await this.deployPackageIfEnabled();

        return 0;
    }

    private async createPackageIfEnabled() {
        //create the zip file if configured to do so
        if (this.options.skipPackage === false || this.options.deploy) {
            util.log(`Creating package at ${this.options.outFile}`);
            await rokuDeploy.createPackage({
                ...this.options,
                outDir: util.getOutDir(this.options),
                outFile: path.basename(this.options.outFile)
            });
        }
    }

    private async deployPackageIfEnabled() {
        //deploy the project if configured to do so
        if (this.options.deploy) {
            util.log(`Deploying package to ${this.options.host}`);
            await rokuDeploy.publish({
                ...this.options,
                outDir: util.getOutDir(this.options),
                outFile: path.basename(this.options.outFile)
            });
        }
    }

    /**
     * Parse and load the AST for every file in the project
     */
    private async loadAllFilesAST() {
        let errorCount = 0;
        let files = await util.getFilePaths(this.options);
        //parse every file
        await Promise.all(
            files.map(async (file) => {
                try {
                    let fileExtension = path.extname(file.src).toLowerCase();

                    //only process brightscript files
                    if (['.bs', '.brs', '.xml'].indexOf(fileExtension) > -1) {
                        await this.program.addOrReplaceFile(file.src);
                    }
                } catch (e) {
                    //log the error, but don't fail this process because the file might be fixable later
                    console.error(e);
                }
            })
        );

        return errorCount;
    }


    /**
     * This only operates on files that match the specified files globs, so it is safe to throw 
     * any file changes you receive with no unexpected side-effects
     * @param changes 
     */
    public async handleFileChanges(changes: FileEvent[]) {
        //lazy-load the list of file paths, and only once for this function call
        let _matchingFilePathsPromise: Promise<string[]>;
        let getMatchingFilePaths = () => {
            if (!_matchingFilePathsPromise) {
                _matchingFilePathsPromise = util.getFilePaths(this.options).then((fileObjects) => {
                    return fileObjects.map(obj => obj.src);
                });
            }
            return _matchingFilePathsPromise;
        }
        //this loop assumes paths are both file paths and folder paths,
        //Which eliminates the need to detect. All functions below can handle being given
        //a file path AND a folder path, and will only operate on the one they are looking for
        for (let change of changes) {
            let pathAbsolute = path.normalize(Uri.parse(change.uri).fsPath);
            //remove all files from any removed folder
            if (change.type === FileChangeType.Deleted) {
                //try to act on this path as a directory
                this.removeFilesInFolder(pathAbsolute)
                //if this is a file loaded in the program, remove it
                if (this.program.hasFile(pathAbsolute)) {
                    this.program.removeFile(pathAbsolute);
                }
            } else if (change.type === FileChangeType.Created) {
                //load all matching missing files from this path (if it's a directory)
                await this.loadMissingFilesFromFolder(pathAbsolute);
                let filePaths = await getMatchingFilePaths();
                //if our program wants this file, then load it
                if (filePaths.indexOf(pathAbsolute)) {
                    this.program.addOrReplaceFile(pathAbsolute);
                }
            } else /*changed*/ {
                if (this.program.hasFile(pathAbsolute)) {
                    //sometimes "changed" events are emitted on files that were actually deleted, 
                    //so determine file existance and act accordingly
                    if (await util.fileExists(pathAbsolute)) {
                        await this.program.addOrReplaceFile(pathAbsolute);
                    } else {
                        await this.program.removeFile(pathAbsolute);
                    }
                }
            }
        }
    }

    /**
     * Remove all files from the program that are in the specified folder path
     * @param folderPathAbsolute 
     */
    public async removeFilesInFolder(folderPathAbsolute: string) {
        for (let filePath in this.program.files) {
            //if the file path starts with the parent path and the file path does not exactly match the folder path
            if (filePath.indexOf(folderPathAbsolute) === 0 && filePath !== folderPathAbsolute) {
                this.program.removeFile(filePath);
            }
        }
    }

    /**
     * Load any files from the given folder that are not already loaded into the program.
     * This is mainly used when folders get moved, but we also have some active changes in
     * some of the files from the new location already
     * @param folderPathAbsolute 
     */
    public async loadMissingFilesFromFolder(folderPathAbsolute: string) {
        folderPathAbsolute = path.normalize(folderPathAbsolute);
        let allFilesObjects = await util.getFilePaths(this.options);

        let promises = [] as Promise<any>[];
        //for every matching file
        for (let fileObj of allFilesObjects) {
            if (
                //file path starts with folder path
                fileObj.src.indexOf(folderPathAbsolute) === 0 &&
                //paths are not identical (solves problem when passing file path into this method instead of folder path)
                fileObj.src != folderPathAbsolute &&
                this.program.hasFile(fileObj.src) === false) {
                promises.push(this.program.addOrReplaceFile(fileObj.src));
            }
        }
        await Promise.all(promises);
    }

    /**
     * Scan every file and resolve all variable references.
     * If no errors were encountered, return true. Otherwise return false.
     */
    private async validateProject() {
        await this.program.validate();
    }

    public dispose() {
        this.watcher.dispose();
        this.program.dispose();
    }
}

export interface BRSConfig {
    /**
     * A path to a project file. This is really only passed in from the command line, and should not be present in brsconfig.json files
     */
    project?: string;
    /**
     * Relative or absolute path to another brsconfig.json file that this file should import and then override
     */
    extends?: string;
    /**
     * Override the current working directory.
     */
    cwd?: string;
    /**
     * The root directory of your roku project. Defaults to current directory.
     */
    rootDir?: string;
    /**
     * The list of file globs used to find all files for the project
     * If using the {src;dest;} format, you can specify a different destination directory
     * for the matched files in src.
     */
    files?: (string | string[] | { src: string | string[]; dest?: string })[];
    /**
     * The path where the output zip file should be placed.
     * @default "./out/package.zip"
     */
    outFile?: string;
    /**
     * Prevents the zip file from being created. This has no effect if deploy is true.
     */
    skipPackage?: boolean;
    /**
     * If true, the server will keep running and will watch and recompile on every file change
     * @default false
     */
    watch?: boolean;

    /**
     * If true, after a success buld, the project will be deployed to the roku specified in host
     */
    deploy?: boolean;

    /**
     * The host of the Roku that this project will deploy to
     */
    host?: string;

    /**
     * The username to use when deploying to a Roku device
     */
    username?: string;
    /**
     * The password to use when deploying to a Roku device
     */
    password?: string;
    /**
     * A list of error codes the compiler should NOT emit, even if encountered.
     */
    ignoreErrorCodes?: number[];

    /**
     * Emit full paths to files when printing diagnostics to the console. Defaults to false
     */
    emitFullPaths?: boolean;
}