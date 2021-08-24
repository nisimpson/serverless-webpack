'use strict';
/**
 * Yarn2 packager.
 *
 * Yarn version 2.0+ specific packagerOptions (default):
 *   flat (false) - Use --flat with install
 *   ignoreScripts (false) - Do not execute scripts during install
 *   noFrozenLockfile (false) - Do not require an up-to-date yarn.lock
 *   networkConcurrency (8) - Specify number of concurrent network requests
 */

const _ = require('lodash');
const BbPromise = require('bluebird');
const Utils = require('../utils');

class Yarn2 {
  // eslint-disable-next-line lodash/prefer-constant
  static get lockfileName() {
    return 'yarn.lock';
  }

  static get copyPackageSectionNames() {
    return ['resolutions'];
  }

  // eslint-disable-next-line lodash/prefer-constant
  static get mustCopyModules() {
    return false;
  }

  static getProdDependencies(cwd) {
    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    const args = [ 'info', '--recursive', '--json' ];

    // If we need to ignore some errors add them here
    const ignoredYarnErrors = [];

    return Utils.spawnProcess(command, args, {
      cwd: cwd
    })
      .catch(err => {
        if (err instanceof Utils.SpawnError) {
          // Only exit with an error if we have critical npm errors for 2nd level inside
          const errors = _.split(err.stderr, '\n');
          const failed = _.reduce(
            errors,
            (failed, error) => {
              if (failed) {
                return true;
              }
              return (
                !_.isEmpty(error) &&
                !_.some(ignoredYarnErrors, ignoredError => _.startsWith(error, `npm ERR! ${ignoredError.npmError}`))
              );
            },
            false
          );

          if (!failed && !_.isEmpty(err.stdout)) {
            return BbPromise.resolve({ stdout: err.stdout });
          }
        }

        return BbPromise.reject(err);
      })
      .then(processOutput => processOutput.stdout)
      .then(stdout =>
        BbPromise.try(() => {
          const lines = Utils.splitLines(stdout);
          const parsedLines = _.map(lines, Utils.safeJsonParse);
          return _.filter(parsedLines, line => !_.isEmpty(line));
        })
      )
      .then(parsedValues => {
        // preprocess dependency list
        const versions = {};

        _.forEach(parsedValues, item => {
          versions[item.value] = item.children.Version;
        });

        const convertValues = (values, path) =>
          _.reduce(
            values,
            (obj, data) => {
              const splitModule = _.split(data[path], '@');
              // If we have a scoped module we have to re-add the @
              if (_.startsWith(data[path], '@')) {
                splitModule.splice(0, 1);
                splitModule[0] = '@' + splitModule[0];
              }
              obj[_.first(splitModule)] = {
                version: versions[data[path]],
                dependencies: data.children ? convertValues(data.children.Dependencies, 'locator') : {}
              };
              return obj;
            },
            {}
          );

        const result = {
          problems: [],
          dependencies: convertValues(parsedValues, 'value')
        };
        return result;
      });
  }

  static rebaseLockfile(pathToPackageRoot, lockfile) {
    const fileVersionMatcher = /[^"/]@(?:file:)?((?:\.\/|\.\.\/).*?)[":,]/gm;
    const replacements = [];
    let match;

    // Detect all references and create replacement line strings
    while ((match = fileVersionMatcher.exec(lockfile)) !== null) {
      replacements.push({
        oldRef: match[1],
        newRef: _.replace(`${pathToPackageRoot}/${match[1]}`, /\\/g, '/')
      });
    }

    // Replace all lines in lockfile
    return _.reduce(replacements, (__, replacement) => _.replace(__, replacement.oldRef, replacement.newRef), lockfile);
  }

  static install(cwd, packagerOptions) {
    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    const args = ['install'];

    // Convert supported packagerOptions
    if (!packagerOptions.noFrozenLockfile) {
      args.push('--frozen-lockfile');
    }
    if (packagerOptions.ignoreScripts) {
      args.push('--ignore-scripts');
    }
    if (packagerOptions.networkConcurrency) {
      args.push(`--network-concurrency ${packagerOptions.networkConcurrency}`);
    }

    return Utils.spawnProcess(command, args, { cwd })
      .return()
      .catch(err => {
        if (!_.isEmpty(err.stdout)) {
          console.log(err.stdout);
        }
        return BbPromise.reject(err);
      });
  }

  // "Yarn install" prunes automatically
  static prune(cwd, packagerOptions) {
    return Yarn2.install(cwd, packagerOptions);
  }

  static runScripts(cwd, scriptNames) {
    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    return BbPromise.mapSeries(scriptNames, scriptName => {
      const args = [ 'run', scriptName ];

      return Utils.spawnProcess(command, args, { cwd });
    }).return();
  }
}

module.exports = Yarn2;
