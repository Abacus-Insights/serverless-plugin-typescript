import * as fs from 'fs-extra'
import * as globby from 'globby'
import * as _ from 'lodash'
import * as path from 'path'
import { ServerlessInstance, ServerlessOptions } from './types'
import * as typescript from './typescript'
import { watchFiles } from './watchFiles'




// Folders
const serverlessFolder = '.serverless'
const buildFolder = '.build'

export class TypeScriptPlugin {

  private originalServicePath: string
  private isWatching: boolean

  serverless: ServerlessInstance
  options: ServerlessOptions
  commands: { [key: string]: any }
  hooks: { [key: string]: Function }

  constructor(serverless: ServerlessInstance, options: ServerlessOptions) {
    this.serverless = serverless
    this.options = options

    this.hooks = {
      'before:run:run': async () => {
        await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies()
      },
      'before:offline:start': async () => {
        await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies()
        this.watchAll()
      },
      'before:offline:start:init': async () => {
        await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies()
        this.watchAll()
      },
      'before:package:createDeploymentArtifacts': async () => {
        await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies(true)
      },
      'after:package:createDeploymentArtifacts': async () => {
        await this.cleanup()
      },
      'before:deploy:function:packageFunction': async () => {
        await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies(true)
      },
      'after:deploy:function:packageFunction': async () => {
        await this.cleanup()
      },
      'before:invoke:local:invoke': async () => {
        const emitedFiles = await this.compileTs()
        await this.copyExtras()
        await this.copyDependencies()
        if (this.isWatching) {
          emitedFiles.forEach(filename => {
            const module = require.resolve(path.resolve(this.originalServicePath, filename))
            delete require.cache[module]
          })
        }
      },
      'after:invoke:local:invoke': () => {
        if (this.options.watch) {
          this.watchFunction()
          this.serverless.cli.log('Waiting for changes ...')
        }
      }
    }
  }

  get functions() {
    return this.options.function
      ? { [this.options.function]: this.serverless.service.functions[this.options.function] }
      : this.serverless.service.functions
  }

  get rootFileNames() {
    return typescript.extractFileNames(this.originalServicePath, this.serverless.service.provider.name, this.functions)
  }

  prepare() {
    // exclude serverless-plugin-typescript
    const functions = this.functions
    for (const fnName in functions) {
      const fn = functions[fnName]
      fn.package = fn.package || {
        exclude: [],
        include: [],
      }
      // Add plugin to excluded packages or an empty array if exclude is undefined
      fn.package.exclude = _.uniq([...fn.package.exclude || [], 'node_modules/serverless-plugin-typescript'])
    }
  }

  async watchFunction(): Promise<void> {
    if (this.isWatching) {
      return
    }

    this.serverless.cli.log(`Watch function ${this.options.function}...`)

    this.isWatching = true
    watchFiles(this.rootFileNames, this.originalServicePath, () => {
      this.serverless.pluginManager.spawn('invoke:local')
    })
  }

  async watchAll(): Promise<void> {
    if (this.isWatching) {
      return
    }

    this.serverless.cli.log(`Watching typescript files...`)

    this.isWatching = true
    watchFiles(this.rootFileNames, this.originalServicePath, () => {
      this.compileTs()
    })
  }

  async compileTs(): Promise<string[]> {
    this.prepare()
    this.serverless.cli.log('Compiling with Typescript...')

    if (!this.originalServicePath) {
      // Save original service path and functions
      this.originalServicePath = this.serverless.config.servicePath
      // Fake service path so that serverless will know what to zip
      this.serverless.config.servicePath = path.join(this.originalServicePath, buildFolder)
    }

    const tsconfig = typescript.getTypescriptConfig(
      this.originalServicePath,
      this.isWatching ? null : this.serverless.cli
    )

    tsconfig.outDir = buildFolder

    const emitedFiles = await typescript.run(this.rootFileNames, tsconfig)
    this.serverless.cli.log('Typescript compiled.')
    return emitedFiles
  }

  async copyExtras() {
    const { service } = this.serverless

    // include any "extras" from the "include" section
    if (service.package.include && service.package.include.length > 0) {
      const files = await globby(service.package.include)

      for (const filename of files) {
        const destFileName = path.resolve(path.join(buildFolder, filename))
        const dirname = path.dirname(destFileName)

        if (!fs.existsSync(dirname)) {
          fs.mkdirpSync(dirname)
        }

        if (!fs.existsSync(destFileName)) {
          fs.copySync(path.resolve(filename), path.resolve(path.join(buildFolder, filename)))
        }
      }
    }
  }

  /**
   * Copy the `node_modules` folder and `package.json` files to the output
   * directory.
   * @param isPackaging Provided if serverless is packaging the service for deployment
   */
  async copyDependencies(isPackaging = false) {
    const outPkgPath = path.resolve(path.join(buildFolder, 'package.json'))
    const outModulesPath = path.resolve(path.join(buildFolder, 'node_modules'))

    // copy development dependencies during packaging
    if (isPackaging) {
      if (fs.existsSync(outModulesPath)) {
        fs.unlinkSync(outModulesPath)
      }

      fs.copySync(
        path.resolve('node_modules'),
        path.resolve(path.join(buildFolder, 'node_modules'))
      )
    } else {
      if (!fs.existsSync(outModulesPath)) {
        await this.linkOrCopy(path.resolve('node_modules'), outModulesPath, 'junction')
      }
    }

    // copy/link package.json
    if (!fs.existsSync(outPkgPath)) {
      await this.linkOrCopy(path.resolve('package.json'), outPkgPath, 'file')
    }
  }

  /**
   * Move built code to the serverless folder, taking into account individual
   * packaging preferences.
   */
  async moveArtifacts(): Promise<void> {
    await fs.copy(
      path.join(this.originalServicePath, buildFolder, serverlessFolder),
      path.join(this.originalServicePath, serverlessFolder)
    )

    if (this.options.function) {
      const fn = this.serverless.service.functions[this.options.function]
      const basename = path.basename(fn.package.artifact)
      fn.package.artifact = path.join(
        this.originalServicePath,
        serverlessFolder,
        path.basename(fn.package.artifact)
      )
      return
    }

    if (this.serverless.service.package.individually) {
      const functionNames = this.serverless.service.getAllFunctions()
      functionNames.forEach(name => {
        this.serverless.service.functions[name].package.artifact = path.join(
          this.originalServicePath,
          serverlessFolder,
          path.basename(this.serverless.service.functions[name].package.artifact)
        )
      })
      return
    }

    this.serverless.service.package.artifact = path.join(
      this.originalServicePath,
      serverlessFolder,
      path.basename(this.serverless.service.package.artifact)
    )
  }

  async cleanup(): Promise<void> {
    await this.moveArtifacts()
    // Restore service path
    this.serverless.config.servicePath = this.originalServicePath
    // Remove temp build folder
    fs.removeSync(path.join(this.originalServicePath, buildFolder))
  }

  /**
   * Attempt to symlink a given path or directory and copy if it fails with an
   * `EPERM` error.
   */
  private async linkOrCopy(
    srcPath: string,
    dstPath: string,
    type?: 'dir' | 'junction' | 'file'
  ): Promise<void> {
    return fs.symlink(srcPath, dstPath, type)
      .catch(error => {
        if (error.code === 'EPERM' && error.errno === -4048) {
          return fs.copy(srcPath, dstPath)
        }
        throw error
      })
  }
}

module.exports = TypeScriptPlugin
