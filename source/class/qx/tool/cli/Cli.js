/* ************************************************************************

   qooxdoo - the new era of web development

   http://qooxdoo.org

   Copyright:
     2018 Zenesis Ltd

   License:
     MIT: https://opensource.org/licenses/MIT
     See the LICENSE file in the project's top-level directory for details.

   Authors:
     * John Spackman (john.spackman@zenesis.com, @johnspackman)

************************************************************************ */

require("@qooxdoo/framework");
const path = require("upath");
const fs = qx.tool.utils.Promisify.fs;
const semver = require("semver");

/**
 * Entry point for the CLI
 */
/* global window */
qx.Class.define("qx.tool.cli.Cli", {
  extend: qx.core.Object,

  construct() {
    this.base(arguments);
    if (qx.tool.cli.Cli.__instance) {
      throw new Error("qx.tool.cli.Cli has already been initialized!");
    }
    qx.tool.cli.Cli.__instance = this;
  },

  members: {
    /** @type {yargs} the current yargs instance */
    yargs: null,

    /** @type {Object} the current argv */
    argv: null,

    /** @type {CompilerApi} the CompilerApi instance */
    _compilerApi: null,

    /** @type {String} the compile.js filename, if there is one */
    _compileJsFilename: null,

    /** @type {String} the compile.json filename, if there is one */
    _compileJsonFilename: null,

    /** @type {Object} Parsed arguments */
    _parsedArgs: null,

    /** @type {Promise} Promise that resolves to the _parsedArgs, but only when completely finished parsing them */
    __promiseParseArgs: null,

    /** @type {Boolean} Whether libraries have had their `.load()` method called yet */
    __librariesNotified: false,

    /**
     * Creates an instance of yargs, with minimal options
     *
     * @return {yargs}
     */
    __createYargs() {
      return this.yargs = require("yargs")
        .locale("en")
        .version()
        .strict(false)
        .showHelpOnFail()
        .help(false)
        .option("force", {
          describe: "Override warnings",
          type: "boolean",
          default: false,
          alias: "F"
        })
        .option("config-file", {
          describe: "Specify the config file to use",
          type: "string",
          alias: "c"
        })
        .option("verbose", {
          alias: "v",
          describe: "enables additional progress output to console",
          default: false,
          type: "boolean"
        })
        .option("quiet", {
          alias: "q",
          describe: "suppresses normal progress output to console",
          type: "boolean"
        });
    },

    /**
     * Initialises this.argv with the bare minimum required to load the config files and begin
     * processing
     */
    __bootstrapArgv() {
      var title = "qooxdoo command line interface";
      title = "\n" + title + "\n" + "=".repeat(title.length) + "\n";
      title += `Versions: @qooxdoo/compiler v${qx.tool.compiler.Version.VERSION}\n\n`;
      title +=
      `Typical usage:
        qx <commands> [options]
        
      Type qx <command> --help for options and subcommands.`;
      let yargs = this.__createYargs()
        .usage(title);
      this.argv = yargs.argv;
    },

    /**
     * Reloads this.argv with the full set of arguments
     */
    async __fullArgv() {
      let yargs = this.__createYargs()
        .help(true)
        .option("set", {
          describe: "sets an environment value for the compiler",
          nargs: 1,
          requiresArg: true,
          type: "string",
          array: true
        })
        .option("set-env", {
          describe: "sets an environment value for the application",
          nargs: 1,
          requiresArg: true,
          type: "string",
          array: true
        })
        .check(argv => {
          // validate that "set-env" is not set or if it is
          // set it's items are strings in the form of key=value
          const regexp = /^[^=\s]+=.+$/;
          const setEnv = argv["set-env"];

          if (!(setEnv === undefined || !setEnv.some(item => !regexp.test(item)))) {
            throw (new Error("Argument check failed: --set-env must be a key=value pair."));
          }
          return true;
        });

      qx.tool.cli.Cli.addYargsCommands(yargs,
        [
          "Add",
          "Clean",
          "Compile",
          "Config",
          "Deploy",
          "Package",
          "Pkg", // alias for Package
          "Create",
          "Lint",
          "Run",
          "Test",
          "Serve"
        ],
        "qx.tool.cli.commands");

      this.argv = await yargs
        .demandCommand()
        .strict()
        .argv;
      await this.__notifyLibraries();
    },

    /**
     * Calls the `.load()` method of each library, safe to call multiple times.  This is
     * to delay the calling of `load()` until after we know that the command has been selected
     * by Yargs
     */
    async __notifyLibraries() {
      if (this.__librariesNotified) {
        return;
      }
      this.__librariesNotified = true;
      for (let i = 0, arr = this._compilerApi.getLibraryApis(); i < arr.length; i++) {
        let libraryApi = arr[i];
        await libraryApi.load();
      }
      await this._compilerApi.afterLibrariesLoaded();
    },

    /**
     * Processes a command.  All commands should use this method when invoked by Yargs, because it
     * provides a standard error control and makes sure that the libraries know what command has
     * been selected.
     *
     * @param command {qx.tool.cli.Command} the command being run
     */
    async processCommand(command) {
      qx.tool.compiler.Console.getInstance().setVerbose(this.argv.verbose);
      this._compilerApi.setCommand(command);
      await this.__notifyLibraries();
      try {
        return await command.process();
      } catch (e) {
        qx.tool.compiler.Console.error("Error: " + (e.stack || e.message));
        process.exit(1);
        return null;
      }
    },

    /**
     * Returns the parsed command line and configuration data
     *
     * @return {Object}
     */
    async getParsedArgs() {
      return await this.__promiseParseArgs;
    },

    /**
     * Parses the command line and loads configuration data from a .js or .json file;
     * if you provide a .js file the file must be a module which returns an object which
     * has any of these properties:
     *
     *  CompilerConfig - the class (derived from qx.tool.cli.api.CompilerApi)
     *    for configuring the compiler
     *
     * Each library can also have a compile.js, and that is also a module which can
     * return an object with any of these properties:
     *
     *  LibraryConfig - the class (derived from qx.tool.cli.api.LibraryApi)
     *    for configuring the library
     *
     */
    async run() {
      var args = qx.lang.Array.clone(process.argv);
      args.shift();
      process.title = args.join(" ");
      this.__promiseParseArgs = this.__parseArgsImpl();
      await this.__promiseParseArgs;
    },

    /**
     * Does the work of parsing command line arguments and loading `compile.js[on]`
     */
    async __parseArgsImpl() {
      this.__bootstrapArgv();


      /*
       * Detect and load compile.json and compile.js
       */
      let defaultConfigFilename = this.argv.configFile || qx.tool.config.Compile.config.fileName;

      var lockfileContent = {
        version: qx.tool.config.Lockfile.getInstance().getVersion()
      };

      let compileJsFilename = qx.tool.cli.Cli.compileJsFilename;
      let compileJsonFilename = qx.tool.config.Compile.config.fileName;
      if (defaultConfigFilename) {
        if (defaultConfigFilename.match(/\.js$/)) {
          compileJsFilename = defaultConfigFilename;
        } else {
          compileJsonFilename = defaultConfigFilename;
        }
      }

      if (await fs.existsAsync(compileJsonFilename)) {
        this._compileJsonFilename = compileJsonFilename;
      }


      /*
       * Create a CompilerAPI
       */

      let CompilerApi = qx.tool.cli.api.CompilerApi;
      if (await fs.existsAsync(compileJsFilename)) {
        let compileJs = await this.__loadJs(compileJsFilename);
        this._compileJsFilename = compileJsFilename;
        if (compileJs.CompilerApi) {
          CompilerApi = compileJs.CompilerApi;
        }
      }
      let compilerApi = this._compilerApi = new CompilerApi(this).set({
        rootDir: ".",
        configFilename: compileJsonFilename
      });

      await compilerApi.load();
      let config = compilerApi.getConfiguration();


      /*
       * Open the lockfile and check versions
       */
      if (defaultConfigFilename) {
        let lockfile = qx.tool.config.Lockfile.config.fileName;
        try {
          var name = path.join(path.dirname(defaultConfigFilename), lockfile);
          lockfileContent = await qx.tool.utils.Json.loadJsonAsync(name) || lockfileContent;
        } catch (ex) {
          // Nothing
        }
        // check semver-type compatibility (i.e. compatible as long as major version stays the same)
        let schemaVersion = semver.coerce(qx.tool.config.Lockfile.getInstance().getVersion(), true).raw;
        let fileVersion = lockfileContent && lockfileContent.version ? semver.coerce(lockfileContent.version, true).raw : "1.0.0";
        if (semver.major(schemaVersion) > semver.major(fileVersion)) {
          if (this.argv.force) {
            let config = {
              verbose: this.argv.verbose,
              quiet: this.argv.quiet,
              save: false
            };
            const installer = new qx.tool.cli.commands.package.Install(config);
            let filepath = installer.getLockfilePath();
            let backup = filepath + ".old";
            await fs.copyFileAsync(filepath, backup);
            if (!this.argv.quiet) {
              qx.tool.compiler.Console.warn(`*** A backup of ${lockfile} has been saved to ${backup}, in case you need to revert to it. ***`);
            }
            await installer.deleteLockfile();
            for (let lib of lockfileContent.libraries) {
              if (!await installer.isInstalled(lib.uri, lib.repo_tag)) {
                if (lib.repo_tag) {
                  await installer.install(lib.uri, lib.repo_tag);
                } else if (lib.path && fs.existsSync(lib.path)) {
                  await installer.installFromLocaPath(lib.path, lib.uri);
                }
              } else if (this.argv.verbose) {
                qx.tool.compiler.Console.info(`>>> ${lib.uri}@${lib.repo_tag} is already installed.`);
              }
            }
            lockfileContent = await installer.getLockfileData();
          } else {
            throw new qx.tool.utils.Utils.UserError(
              `*** Warning ***\n` +
              `The schema of '${lockfile}' has changed. Execute 'qx clean && qx compile --force' to delete and regenerate it.\n` +
              `You might have to re-apply manual modifications to '${lockfile}'.`
            );
          }
        }
      }


      /*
       * Locate and load libraries
       */

      if (!config.libraries) {
        if (fs.existsSync("Manifest.json")) {
          config.libraries = [ "." ];
        }
      }

      if (lockfileContent.libraries) {
        config.packages = {};
        lockfileContent.libraries.forEach(function(library) {
          config.libraries.push(library.path);
          config.packages[library.uri] = library.path;
        });
      }
      // check if we need to load libraries, needs more robust test
      let needLibraries = qx.lang.Type.isArray(this.argv._) && this.argv._[0] !== "clean";
      // check if libraries are loaded
      if (config.libraries && needLibraries) {
        if (!config.libraries.every(libData => fs.existsSync(libData + "/Manifest.json"))) {
          qx.tool.compiler.Console.log("One or more libraries not found - trying to install them from library repository...");
          const installer = new qx.tool.cli.commands.package.Install({
            quiet: true,
            save: false
          });
          await installer.process();
        }

        for (const aPath of config.libraries) {
          let libCompileJsFilename = path.join(aPath, qx.tool.cli.Cli.compileJsFilename);
          let LibraryApi = qx.tool.cli.api.LibraryApi;
          if (await fs.existsAsync(libCompileJsFilename)) {
            let compileJs = await this.__loadJs(libCompileJsFilename);
            if (compileJs.LibraryApi) {
              LibraryApi = compileJs.LibraryApi;
            }
          }

          let libraryApi = new LibraryApi().set({
            rootDir: aPath,
            compilerApi: compilerApi
          });
          compilerApi.addLibraryApi(libraryApi);
          await libraryApi.initialize();
        }
      }


      /*
       * Now everything is loaded, we can process the command line properly
       */
      await this.__fullArgv();

      let parsedArgs = {
        target: this.argv.target,
        outputPath: null,
        locales: null,
        writeAllTranslations: this.argv.writeAllTranslations,
        environment: {},
        verbose: this.argv.verbose
      };

      if (this.argv.locale && this.argv.locale.length) {
        parsedArgs.locales = this.argv.locale;
      }

      if (this.argv["set-env"]) {
        this.argv["set-env"].forEach(function(kv) {
          var m = kv.match(/^([^=\s]+)(=(.+))?$/);
          var key = m[1];
          var value = m[3];
          parsedArgs.environment[key] = value;
        });
      }
      config.targetType = parsedArgs.target||config.defaultTarget||"source";

      if (!config.locales) {
        config.locales = [];
      }
      if (typeof parsedArgs.writeAllTranslations == "boolean") {
        config.writeAllTranslations = parsedArgs.writeAllTranslations;
      }

      if (!config.environment) {
        config.environment = {};
      }

      // Set the environment variables coming from command line arguments
      // in target's environment object. If that object doesn't exist create
      // one and assign it to the target.
      if (config.targets) {
        const target = config.targets.find(target =>
          target.type === config.targetType);
        target.environment = target.environment || {};
        qx.lang.Object.mergeWith(target.environment, parsedArgs.environment, true);
      }

      if (config.sass && config.sass.compiler !== undefined) {
        qx.tool.compiler.resources.ScssConverter.USE_V6_COMPILER = config.sass.compiler == "latest";
      } else {
        qx.tool.compiler.resources.ScssConverter.USE_V6_COMPILER = null;
      }

      if (!config.serve) {
        config.serve = {};
      }

      if (this.isExplicitArg("listen-port")) {
        config.serve.listenPort = this.argv.listenPort;
      } else {
        config.serve.listenPort = config.serve.listenPort || this.argv.listenPort;
      }

      this._parsedArgs = await compilerApi.getConfiguration();
      return this._parsedArgs;
    },

    /**
     * Loads a .js file using `require`, handling exceptions as best as possible
     *
     * @param aPath {String} the file to load
     * @return {Object} the module
     */
    __loadJs: async function(aPath) {
      try {
        let module = require(path.resolve(aPath));
        return module;
      } catch (e) {
        let lines = e.stack.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(/^\s+at/)) {
            lines.splice(i);
          }
        }
        let lineNumber = lines[0].split("evalmachine.<anonymous>:")[1];
        if (lineNumber !== undefined) {
          lines.shift();
          throw new Error("Error while reading " + aPath + " at line " + lineNumber + "\n" + lines.join("\n"));
        } else {
          throw new Error("Error while reading " + aPath + "\n" + lines.join("\n"));
        }
      }
    },

    /**
     * Returns the CompilerApi instance
     *
     * @return {CompilerApi}
     */
    getCompilerApi() {
      return this._compilerApi;
    },

    /**
     * Returns the filename of compile.js, if there is one
     *
     * @return {String?} filename
     */
    getCompileJsFilename() {
      return this._compileJsFilename;
    },

    /**
     * Returns the filename of compile.json, if there is one
     *
     * @return {String?} filename
     */
    getCompileJsonFilename() {
      return this._compileJsonFilename;
    },

    /**
     * Detects whether the command line explicit set an option (as opposed to yargs
     * providing a default value).  Note that this does not handle aliases, use the
     * actual, full option name.
     *
     * @param option {String} the name of the option, eg "listen-port"
     * @return {Boolean}
     */
    isExplicitArg(option) {
      function searchForOption(option) {
        return process.argv.indexOf(option) > -1;
      }
      return searchForOption(`-${option}`) || searchForOption(`--${option}`);
    }
  },

  statics: {
    compileJsFilename: "compile.js",

    /** {CompileJs} singleton instance */
    __instance: null,

    /**
     * Returns the singleton instance, throws an error if it has not been created
     *
     * @return {qx.tool.cli.Cli}
     */
    getInstance() {
      if (!qx.tool.cli.Cli.__instance) {
        throw new Error("CompileJs has not been initialized yet!");
      }
      return qx.tool.cli.Cli.__instance;
    },

    /**
     * Adds commands to Yargs
     *
     * @param yargs {yargs} the Yargs instance
     * @param classNames {String[]} array of class names, each of which is in the `packageName` package
     * @param packageName {String} the name of the package to find each command class
     */
    /* @ignore qx.tool.$$classPath */
    addYargsCommands: function(yargs, classNames, packageName) {
      let pkg = null;
      packageName.split(".").forEach(seg => {
        if (pkg === null) {
          pkg = window[seg];
        } else {
          pkg = pkg[seg];
        }
      });
      classNames.forEach(cmd => {
        require(path.join(qx.tool.$$classPath, packageName.replace(/\./g, "/"), cmd));
        let Clazz = pkg[cmd];
        let data = Clazz.getYargsCommand();
        if (data) {
          if (data.handler === undefined) {
            data.handler = argv => qx.tool.cli.Cli.getInstance().processCommand(new Clazz(argv));
          }

          yargs.command(data);
        }
      });
    }
  }
});
