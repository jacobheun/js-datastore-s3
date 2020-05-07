/* @flow */
'use strict'

/* :: import type {Batch, Query, QueryResult, Callback} from 'interface-datastore' */
const assert = require('assert')
const path = require('upath')

const {
  Adapter,
  Key,
  Errors,
  utils: {
    filter
  }
} = require('interface-datastore')
const createRepo = require('./s3-repo')

/* :: export type S3DSInputOptions = {
  s3: S3Instance,
  createIfMissing: ?boolean
}

declare type S3Instance = {
  config: {
    params: {
      Bucket: ?string
    }
  },
  deleteObject: any,
  getObject: any,
  headBucket: any,
  headObject: any,
  listObjectsV2: any,
  upload: any
}
*/

/**
 * A datastore backed by the file system.
 *
 * Keys need to be sanitized before use, as they are written
 * to the file system as is.
 */
class S3Datastore extends Adapter {
  /* :: path: string */
  /* :: opts: S3DSInputOptions */
  /* :: bucket: string */
  /* :: createIfMissing: boolean */

  constructor (path /* : string */, opts /* : S3DSInputOptions */) {
    super()

    this.path = path
    this.opts = opts
    const {
      createIfMissing = false,
      s3: {
        config: {
          params: {
            Bucket
          } = {}
        } = {}
      } = {}
    } = opts

    assert(typeof Bucket === 'string', 'An S3 instance with a predefined Bucket must be supplied. See the datastore-s3 README for examples.')
    assert(typeof createIfMissing === 'boolean', `createIfMissing must be a boolean but was (${typeof createIfMissing}) ${createIfMissing}`)
    this.bucket = Bucket
    this.createIfMissing = createIfMissing
  }

  /**
   * Returns the full key which includes the path to the ipfs store
   * @param {Key} key
   * @returns {String}
   */
  _getFullKey (key /* : Key */) {
    // Avoid absolute paths with s3
    return path.join('.', this.path, key.toString())
  }

  /**
   * Store the given value under the key.
   *
   * @param {Key} key
   * @param {Buffer} val
   * @returns {Promise}
   */
  async put (key /* : Key */, val /* : Buffer */) /* : Promise */ {
    try {
      await this.opts.s3.upload({
        Key: this._getFullKey(key),
        Body: val
      }).promise()
    } catch (err) {
      if (err.code === 'NoSuchBucket' && this.createIfMissing) {
        await this.opts.s3.createBucket({}).promise()
        return this.put(key, val)
      }
      throw Errors.dbWriteFailedError(err)
    }
  }

  /**
   * Read from s3.
   *
   * @param {Key} key
   * @returns {Promise<Buffer>}
   */
  async get (key /* : Key */) /* : Promise<Buffer> */ {
    try {
      const data = await this.opts.s3.getObject({
        Key: this._getFullKey(key)
      }).promise()

      // If a body was returned, ensure it's a Buffer
      return data.Body ? Buffer.from(data.Body) : null
    } catch (err) {
      if (err.statusCode === 404) {
        throw Errors.notFoundError(err)
      }
      throw err
    }
  }

  /**
   * Check for the existence of the given key.
   *
   * @param {Key} key
   * @returns {Promise<bool>}
   */
  async has (key /* : Key */) /* : Promise<bool> */ {
    try {
      await this.opts.s3.headObject({
        Key: this._getFullKey(key)
      }).promise()
      return true
    } catch (err) {
      if (err.code === 'NotFound') {
        return false
      }
      throw err
    }
  }

  /**
   * Delete the record under the given key.
   *
   * @param {Key} key
   * @returns {Promise}
   */
  async delete (key /* : Key */) /* : Promise */ {
    try {
      await this.opts.s3.deleteObject({
        Key: this._getFullKey(key)
      }).promise()
    } catch (err) {
      throw Errors.dbDeleteFailedError(err)
    }
  }

  /**
   * Create a new batch object.
   *
   * @returns {Batch}
   */
  batch () /* : Batch<Buffer> */ {
    const puts = []
    const deletes = []
    return {
      put (key /* : Key */, value /* : Buffer */) /* : void */ {
        puts.push({ key: key, value: value })
      },
      delete (key /* : Key */) /* : void */ {
        deletes.push(key)
      },
      commit: () /* : Promise */ => {
        const putOps = puts.map((p) => this.put(p.key, p.value))
        const delOps = deletes.map((key) => this.delete(key))
        return Promise.all(putOps.concat(delOps))
      }
    }
  }

  /**
   * Recursively fetches all keys from s3
   * @param {Object} params
   * @returns {Iterator<Key>}
   */
  async * _listKeys (params /* : { Prefix: string, StartAfter: ?string } */) {
    let data
    try {
      data = await this.opts.s3.listObjectsV2(params).promise()
    } catch (err) {
      throw new Error(err.code)
    }

    for (const d of data.Contents) {
      // Remove the path from the key
      yield new Key(d.Key.slice(this.path.length), false)
    }

    // If we didnt get all records, recursively query
    if (data.isTruncated) {
      // If NextMarker is absent, use the key from the last result
      params.StartAfter = data.Contents[data.Contents.length - 1].Key

      // recursively fetch keys
      yield * this._listKeys(params)
    }
  }

  async * _all (q, options) {
    const prefix = path.join(this.path, q.prefix || '')

    let values = true
    if (q.keysOnly != null) {
      values = !q.keysOnly
    }

    // Get all the keys via list object, recursively as needed
    const params /* : Object */ = {
      Prefix: prefix
    }
    let it = this._listKeys(params)

    if (q.prefix != null) {
      it = filter(it, k => k.toString().startsWith(q.prefix))
    }

    for await (const key of it) {
      const res /* : QueryEntry<Buffer> */ = { key }
      if (values) {
        // Fetch the object Buffer from s3
        res.value = await this.get(key)
      }

      yield res
    }
  }

  /**
   * This will check the s3 bucket to ensure access and existence
   *
   * @returns {Promise}
   */
  async open () /* : Promise */ {
    try {
      await this.opts.s3.headObject({
        Key: this.path
      }).promise()
    } catch (err) {
      if (err.statusCode === 404) {
        return this.put(new Key('/', false), Buffer.from(''))
      }

      throw Errors.dbOpenFailedError(err)
    }
  }
}

module.exports = S3Datastore
module.exports.createRepo = (...args) => {
  return createRepo(S3Datastore, ...args)
}
