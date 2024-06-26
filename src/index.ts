/* eslint-disable @typescript-eslint/no-unused-vars */
import debug from 'debug'
import {
  type GuacamoleOptions,
  type UniqueConstraint,
  type UniqueConstraintResult,
  type FetchOptions,
  type DocumentTrimOptions,
  type QueryResult,
  type PropertyValues,
  type PropertyValue,
  type Filter,
  type Criteria,
  type Identifier,
  type DocumentMeta,
  type DocumentUpdate,
  type GraphRelation,
  type LiteralQuery,
  type DocumentDataWithKey,
  type GraphFetchInstruction,
  type GraphFetchOptions,
  isLiteralQuery,
  isDocumentOperationFailure,
  isObjectWithKey,
  isIdentifier,
  isFilter,
  MatchType
} from './types'
import { DbAdmin } from './dbms'
import { Queries } from './queries'
import type {
  CollectionInsertOptions,
  CollectionReadOptions,
  CollectionRemoveOptions,
  CollectionUpdateOptions,
  DocumentCollection,
  DocumentOperationMetadata,
  EdgeCollection
} from 'arangojs/collection'
import type {
  Document,
  DocumentData,
  DocumentMetadata,
  DocumentSelector,
  Edge,
  ObjectWithKey
} from 'arangojs/documents'
import { Database } from 'arangojs'
import { type AqlQuery, isAqlQuery, literal } from 'arangojs/aql'
import type { QueryOptions } from 'arangojs/database'
import type { ArrayCursor } from 'arangojs/cursor'
import type { Config } from 'arangojs/connection'

import _has from 'lodash.has'
import _get from 'lodash.get'
import _pick from 'lodash.pick'
import _omit from 'lodash.omit'

export * from './types'

/** @internal */
const debugFunctions = debug('guacamole:log:function')
const debugQueries = debug('guacamole:log:query')

/** @internal */
const _debug = {
  functions: debugFunctions,
  queries: debugQueries,
  errors: debug('guacamole:debug:error'),
  info: debug('guacamole:debug:info'),
  log: {
    queries: function (data: any) {
      debug.enable('guacamole:log:query')
      debugQueries(data)
      debug.disable()
    },
    functions: function (data: any) {
      debug.enable('guacamole:log:function')
      debugFunctions(data)
      debug.disable()
    }
  }
}

/** @internal */
function _debugFiltersEnabled(guacamole?: GuacamoleOptions, options?: FetchOptions): boolean {
  if (options?.debugFilters) {
    return true
  }

  return !!(guacamole?.debugFilters)
}

/** @internal */
function _debugFilters(
  functionName: string,
  guacamole?: GuacamoleOptions,
  options?: FetchOptions
): void {
  if (_debugFiltersEnabled(guacamole, options)) {
    _debug.log.functions(functionName)
  } else {
    _debug.functions(functionName)
  }
}

/** @internal */
function isObject(val: any): boolean {
  if (!val) {
    return false
  }

  if (typeof val === 'object' && !Array.isArray(val)) {
    return true
  }

  return false
}

/** @internal */
function stripUnderscoreProps(obj: any, except: string[]): any {
  if (!isObject(obj)) {
    return obj
  }

  const props = except && except.length > 0
    ? Object.keys(obj).filter(k => k.startsWith('_') && !except.includes(k))
    : Object.keys(obj).filter(k => k.startsWith('_'))

  if (props && props.length > 0) {
    return _omit(obj, props)
  }

  return obj
}

/** @internal */
function stripProps(obj: any, props: string | string[]): any {
  if (!isObject(obj) || !props) {
    return obj
  }

  return _omit(obj, props)
}

/** @internal */
function keepProps(obj: any, props: string | string[]): any {
  if (!isObject(obj) || !props) {
    return obj
  }

  if (typeof props === 'string') {
    return _pick(obj, [props])
  }

  return _pick(obj, props)
}

/** @internal */
function toQueryResult(data: any[], cursor: ArrayCursor, options?: FetchOptions): QueryResult {
  const result: QueryResult = {
    data
  }

  const dataLength = !data ? 0 : data.length

  if (cursor) {
    result.size = cursor.count ? cursor.count : dataLength
    result.total = cursor.extra?.stats ? cursor.extra.stats.fullCount : undefined
    if (options?.returnStats) {
      result.stats = cursor.extra?.stats ? cursor.extra?.stats : undefined
    }
  }

  return result
}

/** @internal */
interface InstancePool {
  [key: string]: ArangoDBWithSpice
}

/**
 * A class that manages instances of {@link ArangoDB} classes.
 *
 * An `ArangoDB` instance deals with only one `ArangoJS` [Database](https://arangodb.github.io/arangojs/8.1.0/classes/database.Database.html).
 * If you only need to work with one database, then simply use the `ArangoDB` class directly, but if you want to
 * use different databases interchangeably in the same code, then `ArangoConnection` could potentially make that easier.
 * The current limitation, however, is that it only manages multiple database connections (or instances) for the same `ArangoJS`
 * [Config](https://arangodb.github.io/arangojs/8.1.0/types/connection.Config.html) credentials.
 * In other words, you can easily (and only) work with multiple databases that use the same connection credentials.
 *
 * The constructor accepts an `ArangoJS` [Config](https://arangodb.github.io/arangojs/8.1.0/types/connection.Config.html)
 *
 * ```typescript
 * import { aql } from "arangojs/aql";
 * import { ArangoConnection } from "@distributhor/guacamole";
 *
 * const conn = new ArangoConnection({
 *  databaseName: db1,
 *  url: process.env.GUACAMOLE_TEST_DB_URI,
 *  auth: { username: dbAdminUser, password: dbAdminPassword }
 * })
 *
 * const db1: ArangoDB = conn.db(dbName2)
 * const db2: ArangoDB = conn.db(dbName2)
 *
 * const col1 = conn.db(dbName1).col(collectionName1)
 * const doc1 = await conn.db(dbName2).read({ id: 12345678 })
 * const result1: ArrayCursor = await conn.db(dbName3).query(aql)
 *
 * const arangojsDb1: Database = conn.db(dbName1).driver()
 * const col1 = arangojsDb1.collection(collectionName1)
 * const doc1 = conn.db(dbName2).driver().document(id)
 * ```
 */
export class ArangoConnection {
  private readonly guacamole: GuacamoleOptions | undefined
  private readonly arangojs: Database
  private readonly pool: InstancePool = {}

  public readonly system: Database

  constructor(dbs: Config | Database | Config[] | Database[], options?: GuacamoleOptions) {
    this.guacamole = options

    const listOfDb = Array.isArray(dbs) ? dbs : [dbs]
    for (const db of listOfDb) {
      if (!this.arangojs) {
        this.arangojs = db instanceof Database ? db : new Database(db)
      }

      this.pool[this.arangojs.name] = new ArangoDBWithSpice(db, options)
    }

    this.system = this.arangojs.database('_system')
  }

  public driver(db: string): Database {
    return this.getInstance(db).driver
  }

  public db(db: string): ArangoDBWithSpice {
    return this.getInstance(db)
  }

  // public collection<T extends Record<string, any> = any>(
  //   db: string,
  //   collection: string
  // ): DocumentCollection<T> | EdgeCollection<T> {
  //   return this.db(db).collection<T>(collection)
  // }

  public listConnections(): string[] {
    return Object.keys(this.pool)
  }

  /** @internal */
  private getInstance(db: string): ArangoDBWithSpice {
    if (this.pool[db]) {
      return this.pool[db]
    }

    _debug.info(`Adding '${db}' to pool`)
    this.pool[db] = new ArangoDBWithSpice(this.arangojs.database(db), this.guacamole)

    return this.pool[db]
  }
}

/**
 * A thin wrapper around an `ArangoJS` [Database](https://arangodb.github.io/arangojs/8.1.0/classes/database.Database.html)
 * instance. It provides direct and easy access to the ArangoJS instance itself, but also adds a few convenience methods,
 * for optional use.
 *
 * The constructor accepts an `ArangoJS` [Config](https://arangodb.github.io/arangojs/8.1.0/types/connection.Config.html)
 *
 * ```typescript
 * import { aql } from "arangojs/aql";
 * import { ArangoDB } from "@distributhor/guacamole";
 *
 * const db = new ArangoDB({ databaseName: "name", url: "http://127.0.0.1:8529", auth: { username: "admin", password: "letmein" } });
 *
 * // the native ArangoJS driver instance is exposed on the `db.driver` property
 * db.driver.query(aql`FOR d IN user FILTER d.name LIKE ${name} RETURN d`);
 *
 * // the backseat driver method, which immediately calls cursor.all()
 * // on the results, returning all the documents, and not the cursor
 * db.query(aql`FOR d IN user FILTER d.name LIKE ${name} RETURN d`);
 * ```
 */
export class ArangoDB {
  /**
   * A property that exposes the native `ArangoJS`
   * [Database](https://arangodb.github.io/arangojs/8.1.0/classes/database.Database.html) instance.
   */
  public driver: Database
  public system: Database

  /** @internal */
  readonly guacamole: GuacamoleOptions | undefined

  /**
   * The constructor accepts an existing
   * `ArangoJS` [Database](https://arangodb.github.io/arangojs/8.1.0/classes/database.Database.html) instance,
   * **or** an `ArangoJS` [Config](https://arangodb.github.io/arangojs/8.1.0/types/connection.Config.html) configuration.
   */
  constructor(db: Config | Database, options?: GuacamoleOptions) {
    this.driver = db instanceof Database ? db : new Database(db)
    this.system = this.driver.database('_system')
    this.guacamole = options
  }

  /** @internal */
  _queryOpts(fetchOptions: FetchOptions | undefined): FetchOptions | undefined {
    if (!fetchOptions) {
      return undefined
    }

    if (fetchOptions) {
      fetchOptions.guacamole = this.guacamole
    }

    return fetchOptions

    // if (!this.guacamole) {
    //   return options
    // }

    // return Object.assign(fetchOptions, this.guacamole)
  }

  public get dbName(): string {
    return this.driver.name
  }

  public async dbExists(): Promise<boolean> {
    return await this.driver.exists()
  }

  public collection<T extends Record<string, any> = any>(
    collection: string
  ): DocumentCollection<T> | EdgeCollection<T> {
    return this.driver.collection(collection)
  }

  /**
   * The regular `driver.query` method will return a database cursor. If you wish to just
   * return all the documents in the result at once (same as invoking cursor.all()),
   * then use this method instead.
   *
   * TODO: support for generic types on the retun value
   *
   * @param query  A query, as create by the `aql` function
   * @param options  Driver options that may be passed in along with the query
   * @returns a list of objects
   */
  public async query<T = any>(
    query: string | LiteralQuery | AqlQuery,
    options?: QueryOptions
  ): Promise<ArrayCursor<T>> {
    if (typeof query === 'string') {
      return await this.driver.query<T>(literal(query), undefined, options)
    } else if (isLiteralQuery(query)) {
      return await this.driver.query<T>(literal(query.query), query.bindVars, options)
    }

    return await this.driver.query<T>(query, options)
  }

  // WFC - Can't be FetchOptions, because in manual query you can't handle limit, sort etc
  // should differentiate by GuacamoleQueryOptions and FetchOptions and OtherOptionTypes
  public async return<T = any>(
    query: string | LiteralQuery | AqlQuery,
    options?: FetchOptions
  ): Promise<QueryResult<T>> {
    const arangojsQueryOptions: QueryOptions = options?.query ? options.query : {}

    if (options?.fullCount) {
      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    if (options?.printQuery) {
      _debug.log.queries(query)
    } else {
      _debug.queries(query)
    }

    const result = await this.query<T>(query, arangojsQueryOptions)
    const documents = await result.all()

    return toQueryResult(ArangoDB.trimDocuments(documents, options?.trim), result, options)
  }

  /**
   * Will only return the first value of a query result. One can quite easily handle
   * this via the `AQL` query itself, but in cases where you have issued a query where
   * you would typically expect either no result or exactly one result, or are only interested
   * in the first result, it may convenient to simply use use this function instead
   *
   * @param query  A query, as create by the `aql` function
   * @param options  Driver options that may be passed in along with the query
   * @returns an object
   */
  public async returnOne<T = any>(
    query: string | LiteralQuery | AqlQuery,
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    const response = await this.query<T>(query, options?.query)
    const documents = await response.all()

    if (!documents || documents.length === 0 || !documents[0]) {
      return null
    }

    if (Array.isArray(documents[0])) {
      return ArangoDB.trimDocuments(documents[0], options?.trim)
    }

    return ArangoDB.trimDocument(documents[0], options?.trim)
  }

  /** @internal */
  async returnOneInternal<T = any>(
    query: string | LiteralQuery | AqlQuery,
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    const response = await this.query<T>(query, options?.query)
    const documents = await response.all()

    if (!documents || documents.length === 0 || !documents[0]) {
      return null
    }

    // since we already know that we have constructed a query with the trim options included,
    // we only have to additionally trim private props if the option for it is set
    if (options?.trim?.stripPrivateProps) {
      return stripUnderscoreProps(documents[0], ['_key', '_id', '_rev'])
    }

    return documents[0]
  }

  // document not found will throw an error from arango, instead of returning null
  public async read<T extends Record<string, any> = any>(
    collection: string,
    identifier: Identifier | DocumentSelector,
    trim?: DocumentTrimOptions,
    options?: CollectionReadOptions
  ): Promise<Document<T> | null> {
    let d: T | T[] | null

    if (!options) {
      options = {}
    }

    if (options.graceful !== false) {
      options.graceful = true
    }

    if (isIdentifier(identifier)) {
      if (identifier.property) {
        d = await this.fetchOneByProperties<T>(
          collection,
          {
            properties: {
              property: identifier.property, value: identifier.value
            }
          }
        )
      } else {
        d = await this.collection<T>(collection).document(`${identifier.value}`, options)
      }
    } else {
      // LET d = DOCUMENT('${collection}/${id}') RETURN UNSET_RECURSIVE( d, [ "_id", "_rev" ])
      d = await this.collection<T>(collection).document(identifier, options)
    }

    if (!d) {
      return null
    }

    // have to call manual trim operation, since there was no trim
    // in the query itself with a .document()
    return ArangoDB.trimDocument(d, trim)
  }

  public async create<T extends Record<string, any> = any>(
    collection: string,
    data: DocumentData<T> | Array<DocumentData<T>>,
    options?: CollectionInsertOptions
  ): Promise<Array<DocumentOperationMetadata & {
      new?: Document<T>
      old?: Document<T>
    }>> {
    if (Array.isArray(data)) {
      for (const item of data) {
        if (_has(item, '_key') && (item._key === '' || typeof item._key !== 'string')) {
          throw new Error('Invalid _key supplied')
        }

        if (_has(item, '_id') && (item._id === '' || typeof item._id !== 'string')) {
          throw new Error('Invalid _id supplied')
        }
      }

      const result = await this.collection(collection).saveAll(data, options)

      if (isDocumentOperationFailure(result)) {
        throw new Error(result.errorMessage)
      }

      return result as Array<DocumentOperationMetadata & {
        new?: Document<T>
        old?: Document<T>
      }>
    }

    if (_has(data, '_key') && (data._key === '' || typeof data._key !== 'string')) {
      throw new Error('Invalid _key supplied')
    }

    if (_has(data, '_id') && (data._id === '' || typeof data._id !== 'string')) {
      throw new Error('Invalid _id supplied')
    }

    const result = await this.collection(collection).save(data, options)

    return [result]
  }

  public async update<T extends Record<string, any> = any>(
    collection: string,
    update: DocumentUpdate<T> | Array<DocumentDataWithKey<T>>,
    options?: CollectionUpdateOptions
  ): Promise<Array<DocumentOperationMetadata & {
      new?: Document<T>
      old?: Document<T>
    }>> {
    if (Array.isArray(update)) {
      for (const item of update) {
        if (_has(item, '_key') && (item._key === '' || typeof item._key !== 'string')) {
          throw new Error('Invalid _key supplied')
        }

        if (_has(item, '_id') && (item._id === '' || typeof item._id !== 'string')) {
          throw new Error('Invalid _id supplied')
        }
      }

      const result = await this.collection(collection).updateAll(update, options)

      if (isDocumentOperationFailure(result)) {
        throw new Error(result.errorMessage)
      }

      return result as Array<DocumentOperationMetadata & {
        new?: Document<T>
        old?: Document<T>
      }>
    }

    if (isIdentifier(update.key)) {
      if (update.key.property) {
        const query = Queries.updateDocumentsByKeyValue(
          this.collection(collection),
          update.key,
          update.data
        )

        const result = await this.driver.query(query)
        return await result.all() as DocumentOperationMetadata[]
      }

      const result = await this.collection(collection).update(`${update.key.value}`, update.data, options)
      return [result]
    }

    const result = await this.collection(collection).update(`${update.key}`, update.data, options)
    return [result]
  }

  public async delete<T extends Record<string, any> = any>(
    collection: string,
    identifier: DocumentSelector | Identifier | Array<string | ObjectWithKey>,
    dependencies?: any[],
    options?: CollectionRemoveOptions
  ): Promise<Array<DocumentMetadata & {
      old?: Document<T>
    }>> {
    if (dependencies && dependencies.length > 0) {
      if (Array.isArray(identifier)) {
        const response: any[] = []

        for (const i of identifier) {
          const id: Identifier = isObjectWithKey(i)
            ? { property: '_key', value: i._key }
            : { property: '_key', value: i }

          const query = Queries.deleteDocumentsByKeyValue(
            this.collection(collection),
            id, dependencies
          )

          // _debug.log.queries(query)
          // if (options?.printQuery) {
          //   _debug.log.queries(query)
          // } else {
          //   _debug.queries(query)
          // }

          const result = await this.driver.query(query)
          const resultData = await result.all() as DocumentMetadata[]

          response.push(resultData)
        }

        return response
      }

      let id: Identifier

      if (isIdentifier(identifier)) {
        id = identifier
      } else if (isObjectWithKey(identifier)) {
        id = { property: '_key', value: identifier._key }
      } else if (typeof identifier === 'string') {
        id = { property: '_key', value: identifier }
      } else {
        throw new Error('Invalid identifier received')
      }

      const query = Queries.deleteDocumentsByKeyValue(
        this.collection(collection),
        id, dependencies
      )

      // _debug.log.queries(query)

      const result = await this.driver.query(query)
      return await result.all() as DocumentMetadata[]
    }

    if (Array.isArray(identifier)) {
      const result = await this.collection(collection).removeAll(identifier, options)

      if (isDocumentOperationFailure(result)) {
        throw new Error(result.errorMessage)
      }

      return result as Array<DocumentMetadata & {
        old?: Document<T>
      }>
    }

    if (isIdentifier(identifier)) {
      if (identifier.property) {
        const query = Queries.deleteDocumentsByKeyValue(
          this.collection(collection),
          identifier
        )

        const result = await this.driver.query(query)
        return await result.all() as DocumentMetadata[]
      }

      const response = await this.collection(collection).remove(`${identifier.value}`, options)
      return [response]
    }

    const response = await this.collection(collection).remove(identifier, options)
    return [response]
  }

  // add an optional default return value, ie [] for arrays?
  public async fetchProperty<T = any>(
    collection: string,
    identifier: Identifier | DocumentSelector,
    property: string
  ): Promise<T | T[] | null> {
    // in the query below, properties such as prop.nested should be converted into prop[nested] for the query to work
    // return await this.returnOneInternal(`LET d = DOCUMENT("${collection}/${key}") RETURN d.${property}`)
    const d = await this.read(collection, identifier, undefined)

    if (!d) {
      throw new Error('Document not found')
    }

    return _get(d, property)
  }

  public async updateProperty<T = any>(
    collection: string,
    identifier: Identifier | DocumentSelector,
    property: string,
    value: T
  ): Promise<DocumentMeta[]> {
    const d = await this.read(collection, identifier, undefined)

    if (!d) {
      throw new Error('Document not found')
    }

    let query = `LET d = DOCUMENT("${collection}/${d._key}") `

    if (property.includes('.')) {
      const nestedFields = property.split('.')

      query += 'UPDATE d WITH '

      for (const nf of nestedFields) { query += `{ ${nf}: ` }

      query += JSON.stringify(value)

      for (const _nf of nestedFields) { query += ' }' }

      query += ` IN ${collection} OPTIONS { keepNull: false } `

      // I have found no reliable way to replace a sub-document. If that document does not have sibling fields,
      // then it works fine, but if it has sibling fields, those fields will vanish with mergeObject = false
      //
      // if ((options) && (options.hasOwnProperty('replace')) && (options.replace === true)) {
      //    query += ' OPTIONS { keepNull: false, mergeObjects: false } ';
      // } else {
      //    query += ' OPTIONS { keepNull: false } ';
      // }
    } else {
      query += `UPDATE d WITH { ${property}: ${JSON.stringify(value)} } IN ${collection} OPTIONS { keepNull: false } `
    }

    query += ' LET updated = NEW RETURN { "_key": updated._key, "' + property + '": updated.' + property + ' }'

    const results = await this.query(query)

    return await results.all()
  }

  public async fetchAll<T = any>(
    collection: string,
    options?: FetchOptions
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    let arangojsQueryOptions = options?.query

    if (options?.limit ?? options?.fullCount) {
      if (!arangojsQueryOptions) {
        arangojsQueryOptions = {}
      }
      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    const result = await this.driver.query(
      Queries.fetchAll(this.collection(collection), this._queryOpts(options)),
      arangojsQueryOptions
    )

    if (options?.returnCursor) {
      return result
    }

    const documents = await result.all()

    const data = options?.trim?.stripPrivateProps
      ? stripUnderscoreProps(documents, ['_key', '_id', '_rev'])
      : documents

    return toQueryResult(data, result, options)
  }

  public async fetchByProperties<T = any>(
    collection: string,
    values: PropertyValues,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByProperties', this.guacamole, options)

    const match = !Array.isArray(values.properties)
      ? MatchType.ANY
      : (values.match ?? MatchType.ANY)

    return await this._fetchByPropValues(
      collection,
      values.properties,
      match,
      undefined,
      options
    )
  }

  public async fetchOneByProperties<T = any>(
    collection: string,
    values: PropertyValues,
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    _debugFilters('fetchOneByProperties', this.guacamole, options)

    if (!Array.isArray(values.properties)) {
      return await this.returnOneInternal<T>(
        Queries.fetchByMatchingProperty(
          this.collection(collection),
          values.properties,
          this._queryOpts(options)
        ), options
      )
    }

    if (values.match && values.match === MatchType.ALL) {
      return await this.returnOneInternal<T>(
        Queries.fetchByMatchingAllProperties(
          this.collection(collection),
          values.properties,
          this._queryOpts(options)
        ), options
      )
    }

    return await this.returnOneInternal<T>(
      Queries.fetchByMatchingAnyProperty(
        this.collection(collection),
        values.properties,
        this._queryOpts(options)
      ), options
    )
  }

  public async fetchByCriteria<T = any>(
    collection: string,
    criteria: string | AqlQuery | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    _debugFilters('fetchByCriteria', this.guacamole, options)

    if (!criteria) {
      throw new Error('No criteria supplied')
    }

    if (typeof criteria === 'string' || isFilter(criteria) || isAqlQuery(criteria)) {
      return await this._fetchByCriteria(collection, { filter: criteria }, options)
    }

    // if (isSearch(criteria)) {
    //   return await this._fetchByCriteria(collection, { search: criteria }, options)
    // }

    return await this._fetchByCriteria(collection, criteria, options)
  }

  public async fetchByPropertiesAndCriteria<T = any>(
    collection: string,
    values: PropertyValues,
    criteria: string | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByPropertiesAndCriteria', this.guacamole, options)

    const match = !Array.isArray(values.properties)
      ? MatchType.ANY
      : (values.match ?? MatchType.ANY)

    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(
      collection,
      values.properties,
      match,
      filterCriteria,
      options
    )
  }

  public static trimDocument(document: any, options?: DocumentTrimOptions): any {
    if (!document || !isObject(document)) {
      return document
    }

    if (options?.keep) {
      return keepProps(document, options.keep)
    }

    if (options?.omit) {
      const trimmed = stripProps(document, options.omit)
      return options.stripPrivateProps
        ? stripUnderscoreProps(trimmed, ['_key', '_id', '_rev'])
        : trimmed
    }

    if (options?.stripPrivateProps) {
      return stripUnderscoreProps(document, ['_key', '_id', '_rev'])
    }

    return document
  }

  public static trimDocuments(documents: any[], options?: DocumentTrimOptions): any[] {
    if (!documents) {
      return documents
    }

    return documents.map((document) => {
      if (!isObject(document)) {
        return document
      }

      if (options?.keep) {
        return keepProps(document, options.keep)
      }

      if (options?.omit) {
        const trimmed = stripProps(document, options.omit)
        return options.stripPrivateProps
          ? stripUnderscoreProps(trimmed, ['_key', '_id', '_rev'])
          : trimmed
      }

      if (options?.stripPrivateProps) {
        return stripUnderscoreProps(document, ['_key', '_id', '_rev'])
      }

      return document
    })
  }

  public async fetchByPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByPropertyValue', this.guacamole, options)
    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, undefined, options)
  }

  public async fetchByAnyPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue[],
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByAnyPropertyValue', this.guacamole, options)
    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, undefined, options)
  }

  public async fetchByAllPropertyValues<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByAllPropertyValues', this.guacamole, options)
    return await this._fetchByPropValues(collection, propertyValues, MatchType.ALL, undefined, options)
  }

  public async fetchOneByPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    _debugFilters('fetchOneByPropertyValue', this.guacamole, options)
    return await this.returnOneInternal<T>(
      Queries.fetchByMatchingProperty(
        this.collection(collection),
        propertyValue,
        this._queryOpts(options)
      ), options)
  }

  public async fetchOneByAnyPropertyValue<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    _debugFilters('fetchOneByAnyPropertyValue', this.guacamole, options)
    return await this.returnOneInternal<T>(
      Queries.fetchByMatchingAnyProperty(
        this.collection(collection),
        propertyValues,
        this._queryOpts(options)
      ), options)
  }

  public async fetchOneByAllPropertyValues<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options?: FetchOptions
  ): Promise<T | T[] | null> {
    _debugFilters('fetchOneByAllPropertyValues', this.guacamole, options)
    return await this.returnOneInternal<T>(
      Queries.fetchByMatchingAllProperties(
        this.collection(collection),
        propertyValues,
        this._queryOpts(options)
      ), options)
  }

  public async fetchByPropertyValueAndCriteria<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    criteria: string | AqlQuery | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByPropertyValueAndCriteria', this.guacamole, options)
    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(
      collection,
      propertyValue,
      MatchType.ANY,
      filterCriteria,
      options
    )
  }

  public async fetchByAnyPropertyValueAndCriteria<T = any>(
    collection: string,
    propertyValue: PropertyValue[],
    criteria: string | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByAnyPropertyValueAndCriteria', this.guacamole, options)
    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(
      collection,
      propertyValue,
      MatchType.ANY,
      filterCriteria,
      options
    )
  }

  public async fetchByAllPropertyValuesAndCriteria<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    criteria: string | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    _debugFilters('fetchByAllPropertyValuesAndCriteria', this.guacamole, options)
    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(
      collection,
      propertyValues,
      MatchType.ALL,
      filterCriteria,
      options
    )
  }

  // WFC should not be FetchOptions
  public async validateUniqueConstraint(
    collection: string,
    constraints: UniqueConstraint,
    options?: FetchOptions
  ): Promise<UniqueConstraintResult> {
    if (!constraints) {
      throw new Error('No unique constraints specified')
    }

    if (
      (!constraints.singular || (Array.isArray(constraints.singular) && constraints.singular.length === 0)) &&
      (!constraints.composite || (Array.isArray(constraints.composite) && constraints.composite.length === 0))
    ) {
      throw new Error('No unique constraints specified')
    }

    // const query = uniqueConstraintQuery(constraints, QueryType.STRING) as string;
    const query = Queries.uniqueConstraintQuery(this.collection(collection), constraints, this._queryOpts(options))
    const documents = await (await this.query(query)).all()

    return {
      violatesUniqueConstraint: documents.length > 0,
      documents
    }
  }

  /** @internal */
  async _fetchByPropValues<T = any>(
    collection: string,
    propertyValues: PropertyValue | PropertyValue[],
    matchType: MatchType,
    criteria?: string | AqlQuery | Filter | Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor | QueryResult<T>> {
    let filterCriteria: Criteria | undefined

    if (criteria) {
      if (typeof criteria === 'string' || isFilter(criteria)) {
        filterCriteria = { filter: criteria }
      }

      // if (isSearch(criteria)) {
      //   filterCriteria = { search: criteria }
      // }

      filterCriteria = criteria as Criteria
    }

    let arangojsQueryOptions = options?.query

    if (options?.limit ?? options?.fullCount) {
      if (!arangojsQueryOptions) {
        arangojsQueryOptions = {}
      }

      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    let result: ArrayCursor<any> | QueryResult<T> | PromiseLike<ArrayCursor<any> | QueryResult<T>>

    if (Array.isArray(propertyValues)) {
      if (matchType === MatchType.ANY) {
        result = await this.driver.query(
          Queries.fetchByMatchingAnyProperty(
            this.collection(collection),
            propertyValues,
            this._queryOpts(options),
            filterCriteria
          ), arangojsQueryOptions
        )
      } else {
        result = await this.driver.query(
          Queries.fetchByMatchingAllProperties(
            this.collection(collection),
            propertyValues,
            this._queryOpts(options),
            filterCriteria
          ), arangojsQueryOptions
        )
      }
    } else {
      result = await this.driver.query(
        Queries.fetchByMatchingProperty(
          this.collection(collection),
          propertyValues,
          this._queryOpts(options),
          filterCriteria
        ), arangojsQueryOptions
      )
    }

    if (options?.returnCursor) {
      return result
    }

    const documents = await result.all()

    const data = options?.trim?.stripPrivateProps
      ? stripUnderscoreProps(documents, ['_key', '_id', '_rev'])
      : documents

    return toQueryResult(data, result, options)
  }

  /** @internal */
  async _fetchByCriteria<T = any>(
    collection: string,
    criteria: Criteria,
    options?: FetchOptions
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    let arangojsQueryOptions = options?.query

    if (options?.limit ?? options?.fullCount) {
      if (!arangojsQueryOptions) {
        arangojsQueryOptions = {}
      }
      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    const result = await this.driver.query(
      Queries.fetchByCriteria(
        this.collection(collection),
        criteria,
        this._queryOpts(options)
      ), arangojsQueryOptions
    )

    if (options?.returnCursor) {
      return result
    }

    const documents = await result.all()

    const data = options?.trim?.stripPrivateProps
      ? stripUnderscoreProps(documents, ['_key', '_id', '_rev'])
      : documents

    return toQueryResult(data, result, options)
  }
}

export class ArangoDBWithSpice extends ArangoDB {
  /** @internal */
  manage: DbAdmin

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(db: Config | Database, options?: GuacamoleOptions) {
    super(db, options)

    /** @internal */
    this.manage = new DbAdmin(db)
  }

  public async addArrayValue(
    collection: string,
    key: string,
    arrayProperty: string,
    arrayValue: any,
    options?: any
  ): Promise<DocumentMeta[]> {
    const arr = await this.fetchProperty(collection, key, arrayProperty)

    if (arr && !Array.isArray(arr)) {
      throw new Error('Cannot add array value to an existing field that is not already of type array')
    }

    if (!options) {
      options = {}
    }

    const allowDuplicates = _get(options, 'allowDuplicates', false)

    // if the array value is an object we perform a manual uniqueness check,
    // so the arango parameter can be set to false
    const preventDuplicates = isObject(arrayValue) ? false : !allowDuplicates

    if (isObject(arrayValue) && !allowDuplicates) {
      if (!options.uniqueObjectField || !arrayValue[options.uniqueObjectField]) {
        throw new Error(
          "The array object must be unique, no 'uniqueObjectField' was provided, or the array object is missing that field"
        )
      }

      if (arr && arr.length > 0) {
        const matchingObject = arr.find(
          o => o[options.uniqueObjectField] && o[options.uniqueObjectField] === arrayValue[options.uniqueObjectField]
        )

        if (matchingObject) {
          throw new Error('The array object being added is not unique')
        }
      }
    }

    let query = `LET d = DOCUMENT("${collection}/${key}") `

    if (arrayProperty.includes('.')) {
      const nestedFields = arrayProperty.split('.')

      query += 'UPDATE d WITH '

      for (const field of nestedFields) { query += '{ ' + field + ': ' }

      if (Array.isArray(arrayValue)) {
        query += `APPEND(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${preventDuplicates})`
      } else {
        query += `PUSH(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${preventDuplicates})`
      }

      for (const _f of nestedFields) { query += ' }' }

      query += ` IN ${collection} LET updated = NEW RETURN { "_key": updated._key, `

      let countA = 0
      let countB = 0

      for (const field of nestedFields) {
        countA++
        if (countA === nestedFields.length) {
          query += `"${field}": updated.${arrayProperty}`
        } else {
          query += `"${field}": { `
        }
      }

      for (const _f of nestedFields) {
        if (countB > 0) { query += ' }' }
        countB++
      }

      query += ' }'
    } else {
      if (Array.isArray(arrayValue)) {
        query += `UPDATE d WITH { ${arrayProperty}: APPEND(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${preventDuplicates}) } `
        query += `IN ${collection} LET updated = NEW RETURN { "_key": updated._key, "${arrayProperty}": updated.${arrayProperty} }`
      } else {
        query += `UPDATE d WITH { ${arrayProperty}: PUSH(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${preventDuplicates}) } `
        query += `IN ${collection} LET updated = NEW RETURN { "_key": updated._key, "${arrayProperty}": updated.${arrayProperty} }`
      }
    }

    const results = await this.query(query)

    return await results.all()
  }

  public async removeArrayValue(
    collection: string,
    key: string,
    arrayProperty: string,
    arrayValue: any
  ): Promise<DocumentMeta[] | null> {
    const arr = await this.fetchProperty(collection, key, arrayProperty)

    if (arr && !Array.isArray(arr)) {
      throw new Error('Cannot remove array value from an existing field that is not already of type array')
    }

    if (!arr || arr.length === 0) {
      return null
    }

    let query = `LET d = DOCUMENT("${collection}/${key}") `

    if (arrayProperty.includes('.')) {
      const nestedFields = arrayProperty.split('.')

      query += 'UPDATE d WITH '

      for (const field of nestedFields) { query += `{ ${field}: ` }

      query += `REMOVE_VALUE(d.${arrayProperty}, ${JSON.stringify(arrayValue)})`

      for (const _f of nestedFields) { query += ' }' }

      query += ` IN ${collection} LET updated = NEW RETURN { "_key": updated._key, `

      let countA = 0
      let countB = 0

      for (const field of nestedFields) {
        countA++
        if (countA === nestedFields.length) {
          query += `"${field}": updated.${arrayProperty}`
        } else {
          query += `"${field}": { `
        }
      }

      for (const _f of nestedFields) {
        if (countB > 0) { query += ' }' }
        countB++
      }

      query += ' }'
    } else {
      query += `UPDATE d WITH { ${arrayProperty}: REMOVE_VALUE(d.${arrayProperty}, ${JSON.stringify(arrayValue)}) } `
      query += `IN ${collection} LET updated = NEW RETURN { "_key": updated._key, "${arrayProperty}": updated.${arrayProperty} }`
    }

    const results = await this.query(query)

    return await results.all()
  }

  public async addArrayObject(
    collection: string,
    key: string,
    arrayProperty: string,
    arrayObject: any,
    uniqueObjectField?: string,
    options?: any
  ): Promise<DocumentMeta[]> {
    if (!isObject(arrayObject)) {
      throw new Error('Array value is not an object')
    }

    if (!options) {
      options = {}
    }

    if (uniqueObjectField) {
      options.uniqueObjectField = uniqueObjectField
    } else {
      options.allowDuplicates = true
    }

    return await this.addArrayValue(collection, key, arrayProperty, arrayObject, options)
  }

  public async removeArrayObject(
    collection: string,
    key: string,
    arrayProperty: string,
    objectIdField: string,
    objectIdValue: any
  ): Promise<DocumentMeta[] | null> {
    const arr = await this.fetchProperty(collection, key, arrayProperty)

    if (arr && !Array.isArray(arr)) {
      throw new Error('Cannot remove array value from an existing field that is not already of type array')
    }

    if (!arr || arr.length === 0) {
      return null
    }

    let arrayUpdated = false

    const alteredArray = arr.filter(o => {
      if (o[objectIdField] && o[objectIdField] === objectIdValue) {
        arrayUpdated = true
        return false
      }

      return o
    })

    if (arrayUpdated) {
      return await this.updateProperty(collection, key, arrayProperty, alteredArray)
    }

    return null
  }

  public async updateArrayObject(
    collection: string,
    key: string,
    arrayProperty: string,
    objectIdField: string,
    objectIdValue: any,
    updatedObject: any,
    options?: any
  ): Promise<DocumentMeta[] | null> {
    // FOR document in complexCollection
    //   LET alteredList = (
    //     FOR element IN document.subList LET newItem = (
    //       !element.filterByMe ? element : MERGE(element, { attributeToAlter: "shiny New Value" })
    //     )
    //     RETURN newItem
    //   )
    // UPDATE document WITH { subList: alteredList } IN complexCollection

    // var query = 'LET d = DOCUMENT("' + collection + '/' + id + '") ';
    // query += 'LET alteredArray = (';
    // query += '  FOR element IN d.' + arrayProperty + ' LET newElement = element RETURN newElement';
    // query += ') RETURN alteredArray';
    // query += ') UPDATE document WITH { arrayProperty:  alteredArray } IN collection'
    // console.log('UPDATE ARRAY QUERY: ' + query);

    const arr = await this.fetchProperty(collection, key, arrayProperty)

    if (arr && !Array.isArray(arr)) {
      throw new Error('Cannot update array value from an existing field that is not already of type array')
    }

    if (!options) {
      options = {}
    }

    if (!updatedObject[objectIdField]) {
      updatedObject[objectIdField] = objectIdValue
    }

    if (!arr || arr.length === 0) {
      if (_get(options, 'addIfNotFound', false)) {
        if (updatedObject[objectIdField] && updatedObject[objectIdField] !== objectIdValue) {
          throw new Error('Specified ID does not match the one provided in the object instance')
        }

        if (_get(options, 'allowDuplicates', false)) {
          return await this.addArrayObject(collection, key, arrayProperty, updatedObject)
        }

        return await this.addArrayObject(collection, key, arrayProperty, updatedObject, objectIdField)
      }

      return null
    }

    let arrayUpdated = false

    const alteredArray = arr.map(o => {
      if (o[objectIdField] && o[objectIdField] === objectIdValue) {
        arrayUpdated = true

        if (options?.strategy && options.strategy === 'replace') {
          return updatedObject
        }

        // else strategy default = merge (the changes into the existing object)
        return Object.assign(o, updatedObject)
      }

      return o
    })

    if (arrayUpdated) {
      return await this.updateProperty(collection, key, arrayProperty, alteredArray)
    }

    if (_get(options, 'addIfNotFound', false)) {
      if (updatedObject[objectIdField] && updatedObject[objectIdField] !== objectIdValue) {
        throw new Error('Specified ID does not match the one provided in the object instance')
      }

      if (_get(options, 'allowDuplicates', false)) {
        return await this.addArrayObject(collection, key, arrayProperty, updatedObject)
      }

      return await this.addArrayObject(collection, key, arrayProperty, updatedObject, objectIdField)
    }

    return null
  }

  public async replaceArrayObject(
    collection: string,
    key: string,
    arrayProperty: string,
    objectIdField: string,
    objectIdValue: any,
    updatedObject: any,
    options?: any
  ): Promise<DocumentMeta[] | null> {
    if (!options) {
      options = {}
    }
    options.strategy = 'replace'
    return await this.updateArrayObject(
      collection,
      key,
      arrayProperty,
      objectIdField,
      objectIdValue,
      updatedObject,
      options
    )
  }

  public async replaceArray(
    collection: string,
    identifier: Identifier | DocumentSelector,
    arrayProperty: string,
    updatedArray: any[]
  ): Promise<DocumentMeta[] | null> {
    return await this.updateProperty(collection, identifier, arrayProperty, updatedArray)
  }

  // public async edgeRelationExists(dbName, graphName, edgeCollectionName, relation) {
  //   const that = this
  //   const query =
  //           'FOR e IN ' +
  //           edgeCollectionName +
  //           ' FILTER e._from == "' +
  //           relation.from +
  //           '" && e._to == "' +
  //           relation.to +
  //           '" RETURN e._key'
  //   // console.log('EDGE RELATION EXISTS QUERY : ' + query);
  //   return new Promise((resolve, reject) => {
  //     return that
  //       .query(dbName, query)
  //       .then(result => {
  //         if (result.data.length > 0) {
  //           resolve(true)
  //         } else {
  //           resolve(false)
  //         }
  //       })
  //       .catch(e => {
  //         if (e.message) {
  //           reject(e.message)
  //         } else {
  //           reject(e)
  //         }
  //       })
  //   })
  // }

  public async fetchRelations<T = any>(
    fetch: GraphFetchInstruction,
    options?: GraphFetchOptions
  ): Promise<QueryResult<T>> {
    return await this.return(Queries.fetchRelations(fetch, options))
  }

  public async createEdgeRelation<T extends Record<string, any> = any>(
    // graph: string,
    edgeCollection: string,
    relation: GraphRelation | GraphRelation[],
    options?: CollectionInsertOptions
  ): Promise<Array<DocumentOperationMetadata & {
      new?: Document<T>
      old?: Document<T>
    }>> {
    if (Array.isArray(relation)) {
      const edges: Edge[] = []

      for (const r of relation) {
        const _from = _get(r, 'from')
        const _to = _get(r, 'to')

        if (!_from || !_to) {
          continue
        }

        const data = r.data ? r.data : {}
        const edge = {
          _from,
          _to,
          ...data
        }

        edges.push(edge)
      }

      const result = await this.collection(edgeCollection).saveAll(edges, options)

      if (isDocumentOperationFailure(result)) {
        throw new Error(result.errorMessage)
      }

      return result as Array<DocumentOperationMetadata & {
        new?: Document<T>
        old?: Document<T>
      }>
    }

    const _from = _get(relation, 'from')
    const _to = _get(relation, 'to')

    if (!_from || !_to) {
      throw new Error('Cannot create edge relation without relational keys')
    }

    // const allowDuplicateRelations = _get(options, 'allowDuplicates', false)

    const data = relation.data ? relation.data : {}
    const edge = {
      _from,
      _to,
      ...data
    }

    const result = await this.collection(edgeCollection).save(edge, options)

    return [result]

    // if (allowDuplicateRelations) {
    //   const edge = relation.data ? relation.data : {}
    //   edge._from = relation.from
    //   edge._to = relation.to

    //   const result = await this.collection(edgeCollection).save(edge)
    // } else {
    //   that.edgeRelationExists(dbName, graphName, edgeCollectionName, relation).then(exists => {
    //     if (exists) {
    //       resolve({
    //         error: false,
    //         status: 'exists',
    //         message: 'Relation already exists',
    //         relation
    //       })
    //     } else {
    //       that.connection(dbName).then(db => {
    //         // db.graph(graphName)
    //         db.edgeCollection(edgeCollectionName)
    //           .save(relation.data, relation.from, relation.to)
    //           .then(result => {
    //             result.error = false
    //             result.status = 'created'
    //             result.message = 'Relation created'
    //             result.relation = relation
    //             resolve(result)
    //           })
    //           .catch(e => {
    //             reject(e)
    //           })
    //       })
    //     }
    //   })
    // }
  }
}

// _isConnectionError(e) {
//   if (e.code && e.code === 'ECONNREFUSED') {
//     return true
//   } else if (e.message && e.message.includes('ECONNREFUSED')) {
//     return true
//   }
//   return false
// }
