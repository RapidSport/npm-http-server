import http from 'http'
import tmpdir from 'os-tmpdir'
import { parse as parseURL } from 'url'
import { join as joinPaths } from 'path'
import { stat as statFile, readFile } from 'fs'
import { maxSatisfying as maxSatisfyingVersion } from 'semver'
import { parsePackageURL, createPackageURL, getPackage } from './PackageUtils'
import { generateDirectoryTree } from './TreeUtils'
import { getPackageInfo } from './RegistryUtils'
import { createBowerPackage } from './BowerUtils'
import {
  sendNotFoundError,
  sendInvalidURLError,
  sendServerError,
  sendRedirect,
  sendFile,
  sendText,
  sendJSON,
  sendHTML
} from './ResponseUtils'

const TmpDir = tmpdir()

const OneMinute = 60
const OneDay = OneMinute * 60 * 24
const OneYear = OneDay * 365

const checkLocalCache = (dir, callback) =>
  statFile(joinPaths(dir, 'package.json'), (error, stats) => {
    callback(stats && stats.isFile())
  })

const ResolveExtensions = [ '', '.js', '.json' ]

/**
 * Resolves a path like "lib/file" into "lib/file.js" or
 * "lib/file.json" depending on which one is available, similar
 * to how require('lib/file') does.
 */
const resolveFile = (file, useIndex, callback) => {
  ResolveExtensions.reduceRight((next, ext) => {
    const filename = file + ext

    return () => {
      statFile(filename, (error, stats) => {
        if (stats && stats.isFile()) {
          callback(null, filename)
        } else if (useIndex && stats && stats.isDirectory()) {
          resolveFile(joinPaths(filename, 'index'), false, (error, indexFile) => {
            if (error) {
              callback(error)
            } else if (indexFile) {
              callback(null, indexFile)
            } else {
              next()
            }
          })
        } else if (error && error.code !== 'ENOENT') {
          callback(error)
        } else {
          next()
        }
      })
    }
  }, callback)()
}

/**
 * Creates and returns a function that can be used in the "request"
 * event of a standard node HTTP server. Options are:
 *
 * - registryURL    The URL of the npm registry (defaults to https://registry.npmjs.org)
 * - bowerBundle    A special pathname that is used to create and serve zip files required by Bower
 *                  (defaults to "/bower.zip")
 * - redirectTTL    The TTL (in seconds) for redirects (defaults to 0)
 * - autoIndex      Automatically generate index HTML pages for directories (defaults to true)
 *
 * Supported URL schemes are:
 *
 * /history@1.12.5/umd/History.min.js (recommended)
 * /history@1.12.5 (package.json's main is implied)
 *
 * Additionally, the following URLs are supported but will return a
 * temporary (302) redirect:
 *
 * /history (redirects to version, latest is implied)
 * /history/umd/History.min.js (redirects to version, latest is implied)
 * /history@latest/umd/History.min.js (redirects to version)
 * /history@^1/umd/History.min.js (redirects to max satisfying version)
 */
export const createRequestHandler = (options = {}) => {
  const registryURL = options.registryURL || 'https://registry.npmjs.org'
  const bowerBundle = options.bowerBundle || '/bower.zip'
  const redirectTTL = options.redirectTTL || 0
  const autoIndex = options.autoIndex !== false
  const maximumDepth = options.maximumDepth || Number.MAX_VALUE

  const handleRequest = (req, res) => {
    const url = parsePackageURL(req.url)
    const baseUrl = req.originalUrl.slice(0, req.originalUrl.length - req.url.length)
    
    console.log(baseUrl, req.url, url);

    if (url == null)
      return sendInvalidURLError(res, req.url)

    const { packageName, version, filename, search } = url
    const displayName = `${packageName}@${version}`
    const tarballDir = joinPaths(TmpDir, packageName + '-' + version)

    const serveFile = () => {
      if (filename === bowerBundle) {
        createBowerPackage(tarballDir, (error, file) => {
          if (error) {
            sendServerError(res, error)
          } else if (file == null) {
            sendNotFoundError(res, `bower.zip in package ${displayName}`)
          } else {
            sendFile(res, file, OneYear)
          }
        })
      } else if (filename) {
        const filepath = joinPaths(tarballDir, filename)

        // Try to serve the file in the URL, or at least a directory index page.
        resolveFile(filepath, false, (error, file) => {
          if (error) {
            sendServerError(res, error)
          } else if (file) {
            sendFile(res, file, OneYear)
          } else if (autoIndex) {
            statFile(filepath, (error, stats) => {
              if (stats && stats.isDirectory()) {
                // Append `/` to directory URLs
                if (req.url[req.url.length - 1] !== '/') {
                  sendRedirect(res, baseUrl + '/', redirectTTL)
                } else {
                  generateDirectoryTree(tarballDir, filename, maximumDepth, (error, json) => {
                    if (json) {
                      sendJSON(res, json, OneYear)
                    } else {
                      sendServerError(res, `unable to generate index json for ${displayName}${filename}`)
                    }
                  })
                }
              } else {
                sendNotFoundError(res, `file "${filename}" in package ${displayName}`)
              }
            })
          } else {
            sendNotFoundError(res, `file "${filename}" in package ${displayName}`)
          }
        })
      } else {
        // No filename in the URL. Try to serve the package's "main" file.
        readFile(joinPaths(tarballDir, 'package.json'), 'utf8', (error, data) => {
          if (error)
            return sendServerError(res, error)

          let packageConfig
          try {
            packageConfig = JSON.parse(data)
          } catch (error) {
            return sendText(res, 500, `Error parsing package.json: ${error.message}`)
          }

          const queryMain = req.query && req.query.main

          if (queryMain && !(queryMain in packageConfig))
            return sendNotFoundError(res, `field "${queryMain}" in package.json of ${packageName}@${version}`)

          // Default main is index, same as npm.
          const mainProperty = queryMain || 'main'
          const mainFilename = packageConfig[mainProperty] || 'index'

          resolveFile(joinPaths(tarballDir, mainFilename), true, (error, file) => {
            if (error) {
              sendServerError(res, error)
            } else if (file == null) {
              sendNotFoundError(res, `main file "${mainFilename}" in package ${packageName}@${version}`)
            } else {
              sendFile(res, file, OneYear)
            }
          })
        })
      }
    }

    checkLocalCache(tarballDir, (isCached) => {
      if (isCached)
        return serveFile() // Best case: we already have this package on disk.

      // Fetch package info from NPM registry.
      getPackageInfo(registryURL, packageName, (error, response) => {
        if (error)
          return sendServerError(res, error)

        if (response.status === 404)
          return sendNotFoundError(res, `package "${packageName}"`)

        const info = response.jsonData

        if (info == null || info.versions == null)
          return sendServerError(res, new Error(`Unable to retrieve info for package ${packageName}`))

        const { versions, 'dist-tags': tags } = info

        if (version in versions) {
          // A valid request for a package we haven't downloaded yet.
          const packageConfig = versions[version]
          const tarballURL = parseURL(packageConfig.dist.tarball)

          getPackage(tarballURL, tarballDir, (error) => {
            if (error) {
              sendServerError(res, error)
            } else {
              serveFile()
            }
          })
        } else if (version in tags) {
          sendRedirect(res, baseUrl + createPackageURL(packageName, tags[version], filename, search), redirectTTL)
        } else {
          const maxVersion = maxSatisfyingVersion(Object.keys(versions), version)

          if (maxVersion) {
            sendRedirect(res, baseUrl + createPackageURL(packageName, maxVersion, filename, search), redirectTTL)
          } else {
            sendNotFoundError(res, `package ${packageName}@${version}`)
          }
        }
      })
    })
  }

  return handleRequest
}

/**
 * Creates and returns an HTTP server that serves files from NPM packages.
 */
export const createServer = (options) =>
  http.createServer(
    createRequestHandler(options)
  )
