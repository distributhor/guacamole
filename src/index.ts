/* eslint-disable no-prototype-builtins */
/* eslint-disable @typescript-eslint/no-unused-vars */
import Debug from 'debug'
import {
  GuacamoleOptions,
  EntityAvailability,
  GraphDefinition,
  DBStructure,
  DBStructureResult,
  DBStructureValidation,
  DBClearanceMethod,
  isGraphDefinitionArray,
  UniqueConstraint,
  UniqueConstraintResult,
  FetchOptions,
  DocumentTrimOptions,
  QueryResult,
  PropertyValues,
  PropertyValue,
  Filter,
  Criteria,
  Identifier,
  MatchType,
  DocumentMeta,
  DocumentUpdate,
  isIdentifier,
  isFilter
} from './types'
import { Queries } from './queries'
import {
  CollectionInsertOptions,
  CollectionReadOptions,
  CollectionRemoveOptions,
  CollectionUpdateOptions,
  DocumentCollection,
  EdgeCollection
} from 'arangojs/collection'
import {
  Document,
  DocumentData,
  DocumentSelector,
  ObjectWithKey
} from 'arangojs/documents'
import { Database } from 'arangojs'
import { AqlQuery, isAqlQuery, literal } from 'arangojs/aql'
import { QueryOptions } from 'arangojs/database'
import { ArrayCursor } from 'arangojs/cursor'
import { Config } from 'arangojs/connection'

import _get from 'lodash.get'

export * from './types'

/** @internal */
const debugInfo = Debug('guacamole:info')

/** @internal */
const debugError = Debug('guacamole:error')

/** @internal */
function toGraphNames(graphs: string[] | GraphDefinition[]): string[] {
  if (graphs.length === 0) {
    return []
  }

  if (isGraphDefinitionArray(graphs)) {
    return graphs.map((g) => g.graph)
  }

  return graphs
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
function stripUnderscoreProps(obj: any, keep: string[]): void {
  // the check for whether this is an object is handled
  // by the functions that call this utility
  Object.keys(obj).map((k) => {
    if (k.startsWith('_') && !keep.includes(k)) {
      delete obj[k]
    }

    return k
  })
}

/** @internal */
function stripProps(obj: any, props: string[]): void {
  // the check for whether this is an object is handled
  // by the functions that call this utility
  Object.keys(obj).map((k) => {
    if (props.includes(k)) {
      delete obj[k]
    }

    return k
  })
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
  private readonly guacamole: GuacamoleOptions
  private readonly arangojs: Database
  private readonly pool: InstancePool = {}

  public readonly system: Database

  constructor(dbs: Config | Database | Config[] | Database[], options: GuacamoleOptions = {}) {
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

  public col<T extends Record<string, any> = any>(
    db: string,
    collection: string
  ): DocumentCollection<T> | EdgeCollection<T> {
    return this.db(db).col<T>(collection)
  }

  public listConnections(): string[] {
    return Object.keys(this.pool)
  }

  /** @internal */
  private getInstance(db: string): ArangoDBWithSpice {
    if (this.pool[db]) {
      return this.pool[db]
    }

    debugInfo(`Adding '${db}' to pool`)
    this.pool[db] = new ArangoDBWithSpice(this.arangojs.database(db), this.guacamole)

    return this.pool[db]
  }
}

export class ArangoDBWithoutSauce {
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
  _debugFunctions(): boolean {
    return !!(this.guacamole?.debugFunctions)
  }

  /** @internal */
  _fetchOptions(fetchOptions: FetchOptions = {}): FetchOptions {
    fetchOptions.guacamole = this.guacamole

    return fetchOptions

    // if (!this.guacamole) {
    //   return options
    // }

    // return Object.assign(fetchOptions, this.guacamole)
  }

  public get name(): string {
    return this.driver.name
  }

  public col<T extends Record<string, any> = any>(collection: string): DocumentCollection<T> | EdgeCollection<T> {
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
  public async query<T = any>(query: string | AqlQuery, options?: QueryOptions): Promise<ArrayCursor<T>> {
    if (typeof query === 'string') {
      return await this.driver.query<T>(literal(query), options)
    }

    return await this.driver.query<T>(query, options)
  }

  public async returnAll<T = any>(query: string | AqlQuery, options?: FetchOptions): Promise<QueryResult<T>> {
    const response = await this.query<T>(query, options?.query)
    const documents = await response.all()
    return {
      data: ArangoDB.trimDocuments(documents, options?.trim)
    }
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
  public async returnOne<T = any>(query: string | AqlQuery, options?: FetchOptions): Promise<T | T[] | null> {
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

  public async read<T extends Record<string, any> = any>(
    collection: string,
    identifier: Identifier | DocumentSelector,
    trim: DocumentTrimOptions = {},
    options: CollectionReadOptions = {}
  ): Promise<Document<T> | null> {
    let d

    if (options.graceful !== false) {
      options.graceful = true
    }

    if (isIdentifier(identifier)) {
      if (identifier.property) {
        // d = await this.fetchOneByPropertyValue<T>(collection, { property: identifier.property, value: identifier.value })
        d = await this.fetchOneByProperties<T>(collection, {
          properties: { property: identifier.property, value: identifier.value }
        })
      } else {
        d = await this.driver.collection<T>(collection).document(`${identifier.value}`, options)
      }
    } else {
      // LET d = DOCUMENT('${collection}/${id}') RETURN UNSET_RECURSIVE( d, [ "_id", "_rev" ])
      d = await this.driver.collection<T>(collection).document(identifier, options)
    }

    if (!d) {
      return null
    }

    return ArangoDB.trimDocument(d, trim)
  }

  public async create<T extends Record<string, any> = any>(
    collection: string,
    data: DocumentData<T> | Array<DocumentData<T>>,
    options?: CollectionInsertOptions
  ): Promise<Array<DocumentMeta & { new?: Document<T> }>> {
    if (Array.isArray(data)) {
      return await this.driver.collection(collection).saveAll(data, options)
    }

    const result = await this.driver.collection(collection).save(data, options)

    return [result]
  }

  public async update<T extends Record<string, any> = any>(
    collection: string,
    document: DocumentUpdate | any[],
    options: CollectionUpdateOptions = {}
  ): Promise<Array<DocumentMeta & { new?: Document<T>, old?: Document<T> }>> {
    if (Array.isArray(document)) {
      return await this.driver.collection(collection).updateAll(document, options)
    }

    if (document.property) {
      const query = Queries.updateDocumentsByKeyValue(
        this.driver.collection(collection),
        { property: document.property, value: document.value },
        document.data
      )

      const result = await this.driver.query(query)

      return await result.all()
    }

    const result = await this.driver.collection(collection).update(`${document.value}`, document.data, options)

    return [result]
  }

  public async delete<T extends Record<string, any> = any>(
    collection: string,
    identifier: DocumentSelector | Identifier | Array<string | ObjectWithKey>,
    options: CollectionRemoveOptions = {}
  ): Promise<Array<DocumentMeta & { old?: Document<T> }>> {
    if (Array.isArray(identifier)) {
      return await this.driver.collection(collection).removeAll(identifier, options)
    }

    if (isIdentifier(identifier)) {
      if (identifier.property) {
        const query = Queries.deleteDocumentsByKeyValue(
          this.driver.collection(collection),
          { property: identifier.property, value: identifier.value }
        )

        const result = await this.driver.query(query)

        return await result.all()
      } else {
        const response = await this.driver.collection(collection).remove(`${identifier.value}`, options)
        return [response]
      }
    } else {
      const response = await this.driver.collection(collection).remove(identifier, options)
      return [response]
    }
  }

  public async fetchProperty<T = any>(
    collection: string,
    identifier: Identifier | DocumentSelector,
    property: string
  ): Promise<T | T[] | null> {
    // in the query below, properties such as prop.nested should be converted into prop[nested] for the query to work
    // return await this.returnOne(`LET d = DOCUMENT("${collection}/${key}") RETURN d.${property}`)
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
    } else {
      query += `UPDATE d WITH { ${property}: ${JSON.stringify(value)} } IN ${collection} OPTIONS { keepNull: false } `
    }

    query += ' LET updated = NEW RETURN { "_key": updated._key, "' + property + '": updated.' + property + ' }'

    const results = await this.query(query)

    return await results.all()
  }

  public async fetchAll<T = any>(
    collection: string,
    options: FetchOptions = {}
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    const fetchOptions = this._fetchOptions(options)

    let arangojsQueryOptions = fetchOptions?.query

    if (fetchOptions.limit) {
      if (!arangojsQueryOptions) {
        arangojsQueryOptions = {}
      }
      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    const result = await this.driver.query(
      Queries.fetchAll(collection, fetchOptions),
      arangojsQueryOptions
    )

    if (fetchOptions.returnCursor) {
      return result
    }

    const documents = await result.all()

    const response = {
      data: ArangoDB.trimDocuments(documents, fetchOptions?.trim),
      size: result.count,
      total: result.extra?.stats ? result.extra.stats.fullCount : undefined
      // stats: result.extra.stats
    }

    return response
  }

  public async fetchByProperties<T = any>(
    collection: string,
    values: PropertyValues,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByPropertyValues: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    if (!Array.isArray(values.properties)) {
      return await this._fetchByPropValues(
        collection,
        values.properties,
        MatchType.ANY,
        undefined,
        fetchOptions
      )
    }

    const match = values.match ?? MatchType.ANY

    return await this._fetchByPropValues(
      collection,
      values.properties,
      match,
      undefined,
      fetchOptions)
  }

  public async fetchOneByProperties<T = any>(
    collection: string,
    values: PropertyValues,
    options: FetchOptions = {}
  ): Promise<T | T[] | null> {
    if (this._debugFunctions()) {
      console.log(`fetchOneByPropertyValues: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    if (!Array.isArray(values.properties)) {
      return await this.returnOne<T>(Queries.fetchByMatchingProperty(
        this.col(collection),
        values.properties,
        fetchOptions),
      fetchOptions)
    }

    if (values.match && values.match === MatchType.ALL) {
      return await this.returnOne<T>(Queries.fetchByMatchingAllProperties(
        this.col(collection),
        values.properties,
        fetchOptions),
      fetchOptions
      )
    }

    return await this.returnOne<T>(Queries.fetchByMatchingAnyProperty(
      this.col(collection),
      values.properties,
      fetchOptions),
    fetchOptions
    )
  }

  public async fetchByCriteria<T = any>(
    collection: string,
    criteria: string | AqlQuery | Filter | Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByCriteria: ${collection}`)
    }

    if (!criteria) {
      throw new Error('No criteria supplied')
    }

    const fetchOptions = this._fetchOptions(options)

    if (typeof criteria === 'string' || isFilter(criteria) || isAqlQuery(criteria)) {
      return await this._fetchByCriteria(collection, { filter: criteria }, fetchOptions)
    }

    // if (isSearch(criteria)) {
    //   return await this._fetchByCriteria(collection, { search: criteria }, fetchOptions)
    // }

    return await this._fetchByCriteria(collection, criteria, fetchOptions)
  }

  public async fetchByPropertiesAndCriteria<T = any>(
    collection: string,
    values: PropertyValues,
    criteria: string | Filter | Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByPropertyValuesAndCriteria: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    if (!Array.isArray(values.properties)) {
      return await this._fetchByPropValues(collection, values.properties, MatchType.ANY, filterCriteria, fetchOptions)
    }

    const match = values.match ?? MatchType.ANY

    return await this._fetchByPropValues(collection, values.properties, match, filterCriteria, fetchOptions)
  }

  public static trimDocument(document: any, options: DocumentTrimOptions = {}): any {
    if (!document || !isObject(document)) {
      return document
    }

    if (options.trimPrivateProps) {
      stripUnderscoreProps(document, ['_key', '_id', '_rev'])
    }

    if (options.trimProps) {
      stripProps(document, options.trimProps)
    }

    return document
  }

  public static trimDocuments(documents: any[], options: DocumentTrimOptions = {}): any[] {
    if (!documents) {
      return documents
    }

    documents.map((document) => {
      if (!isObject(document)) {
        return document
      }

      if (options.trimPrivateProps) {
        stripUnderscoreProps(document, ['_key', '_id', '_rev'])
      }

      if (options.trimProps) {
        stripProps(document, options.trimProps)
      }

      return document
    })

    return documents
  }

  public async validateUniqueConstraint(
    constraints: UniqueConstraint
  ): Promise<UniqueConstraintResult> {
    if (!constraints || constraints.constraints.length === 0) {
      throw new Error('No constraints specified')
    }

    // const query = uniqueConstraintQuery(constraints, QueryType.STRING) as string;
    const query = Queries.uniqueConstraintQuery(constraints)
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
    options: FetchOptions = {}
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

    if (options.limit) {
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
          Queries.fetchByMatchingAnyProperty(this.col(collection), propertyValues, options, filterCriteria),
          arangojsQueryOptions
        )
      } else {
        result = await this.driver.query(
          Queries.fetchByMatchingAllProperties(this.col(collection), propertyValues, options, filterCriteria),
          arangojsQueryOptions
        )
      }
    } else {
      result = await this.driver.query(
        Queries.fetchByMatchingProperty(this.col(collection), propertyValues, options, filterCriteria),
        arangojsQueryOptions
      )
    }

    if (options.returnCursor) {
      return result
    }

    const documents = await result.all()

    const response = {
      data: ArangoDB.trimDocuments(documents, options?.trim),
      size: result.count,
      total: result.extra?.stats ? result.extra.stats.fullCount : undefined
      // stats: result.extra.stats
    }

    return response
  }

  /** @internal */
  async _fetchByCriteria<T = any>(
    collection: string,
    criteria: Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor<T> | QueryResult<T>> {
    let arangojsQueryOptions = options?.query

    if (options.limit) {
      if (!arangojsQueryOptions) {
        arangojsQueryOptions = {}
      }
      arangojsQueryOptions.count = true
      arangojsQueryOptions.fullCount = true
    }

    const result = await this.driver.query(
      Queries.fetchByCriteria(this.col(collection), criteria, options),
      arangojsQueryOptions
    )

    if (options.returnCursor) {
      return result
    }

    const documents = await result.all()

    const response = {
      data: ArangoDB.trimDocuments(documents, options?.trim),
      size: result.count,
      total: result.extra?.stats ? result.extra.stats.fullCount : undefined
      // stats: result.extra.stats
    }

    return response
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
 * db.returnAll(aql`FOR d IN user FILTER d.name LIKE ${name} RETURN d`);
 * ```
 */
export class ArangoDB extends ArangoDBWithoutSauce {
  constructor(db: Config | Database, options: GuacamoleOptions = {}) {
    super(db, options)
  }

  public async fetchByPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByPropertyValue: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, undefined, fetchOptions)
  }

  public async fetchByAnyPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue[],
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByAnyPropertyValue: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, undefined, fetchOptions)
  }

  public async fetchByAllPropertyValues<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByAllPropertyValues: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this._fetchByPropValues(collection, propertyValues, MatchType.ALL, undefined, fetchOptions)
  }

  public async fetchOneByPropertyValue<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    options: FetchOptions = {}
  ): Promise<T | T[] | null> {
    if (this._debugFunctions()) {
      console.log(`fetchOneByPropertyValue: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this.returnOne<T>(Queries.fetchByMatchingProperty(
      this.col(collection),
      propertyValue,
      fetchOptions),
    fetchOptions)
  }

  public async fetchOneByAnyPropertyValue<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options: FetchOptions = {}
  ): Promise<T | T[] | null> {
    if (this._debugFunctions()) {
      console.log(`fetchOneByAnyPropertyValues: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this.returnOne<T>(Queries.fetchByMatchingAnyProperty(
      this.col(collection),
      propertyValues,
      fetchOptions),
    fetchOptions)
  }

  public async fetchOneByAllPropertyValues<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    options: FetchOptions = {}
  ): Promise<T | T[] | null> {
    if (this._debugFunctions()) {
      console.log(`fetchOneByAllPropertyValues: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    return await this.returnOne<T>(Queries.fetchByMatchingAllProperties(
      this.col(collection),
      propertyValues,
      fetchOptions),
    fetchOptions
    )
  }

  public async fetchByPropertyValueAndCriteria<T = any>(
    collection: string,
    propertyValue: PropertyValue,
    criteria: string | AqlQuery | Filter | Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByPropertyValueAndCriteria: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, filterCriteria, fetchOptions)
  }

  public async fetchByAnyPropertyValueAndCriteria<T = any>(
    collection: string,
    propertyValue: PropertyValue[],
    criteria: string | Filter | Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByAnyPropertyValueAndCriteria: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(collection, propertyValue, MatchType.ANY, filterCriteria, fetchOptions)
  }

  public async fetchByAllPropertyValuesAndCriteria<T = any>(
    collection: string,
    propertyValues: PropertyValue[],
    criteria: string | Filter | Criteria,
    options: FetchOptions = {}
  ): Promise<ArrayCursor | QueryResult<T>> {
    if (this._debugFunctions()) {
      console.log(`fetchByAllPropertyValuesAndCriteria: ${collection}`)
    }

    const fetchOptions = this._fetchOptions(options)

    const filterCriteria = typeof criteria === 'string'
      ? { filter: criteria }
      : criteria

    return await this._fetchByPropValues(collection, propertyValues, MatchType.ALL, filterCriteria, fetchOptions)
  }
}

export class ArangoDBWithSpice extends ArangoDB {
  constructor(db: Config | Database, options: GuacamoleOptions = {}) {
    super(db, options)
  }

  public async addArrayValue(
    collection: string,
    key: string,
    arrayProperty: string,
    arrayValue: any,
    options: any = {}
  ): Promise<DocumentMeta[]> {
    const arr = await this.fetchProperty(collection, key, arrayProperty)

    if (arr && !Array.isArray(arr)) {
      throw new Error('Cannot add array value to an existing field that is not already of type array')
    }

    let unique = !!((options.hasOwnProperty('allowDuplicates') && options.allowDuplicates === true))

    if (isObject(arrayValue) && !options.allowDuplicates) {
      if (!options.uniqueObjectField || !arrayValue[options.uniqueObjectField]) {
        throw new Error(
          "The array object must be unique, no 'uniqueObjectField' was provided, or the array object is missing that field"
        )
      }

      // we are manually performing a uniqueness check,
      // so for the arango query this can be set to false
      unique = false

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
        query += `APPEND(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${unique})`
      } else {
        query += `PUSH(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${unique})`
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
        query += `UPDATE d WITH { ${arrayProperty}: APPEND(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${unique}) } `
        query += `IN ${collection} LET updated = NEW RETURN { "_key": updated._key, "${arrayProperty}": updated.${arrayProperty} }`
      } else {
        query += `UPDATE d WITH { ${arrayProperty}: PUSH(d.${arrayProperty}, ${JSON.stringify(arrayValue)}, ${unique}) } `
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
    options: any = {}
  ): Promise<DocumentMeta[]> {
    if (!isObject(arrayObject)) {
      throw new Error('Array value is not an object')
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
    options: any = {}
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

    if (!updatedObject[objectIdField]) {
      updatedObject[objectIdField] = objectIdValue
    }

    if (!arr || arr.length === 0) {
      if (options.hasOwnProperty('addIfNotFound') && options.addIfNotFound === true) {
        if (updatedObject[objectIdField] && updatedObject[objectIdField] !== objectIdValue) {
          throw new Error('Specified ID does not match the one provided in the object instance')
        }

        if (options.hasOwnProperty('allowDuplicates') && options.allowDuplicates === true) {
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

    if (options.hasOwnProperty('addIfNotFound') && options.addIfNotFound === true) {
      if (updatedObject[objectIdField] && updatedObject[objectIdField] !== objectIdValue) {
        throw new Error('Specified ID does not match the one provided in the object instance')
      }

      if (options.hasOwnProperty('allowDuplicates') && options.allowDuplicates === true) {
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
    options: any = {}
  ): Promise<DocumentMeta[] | null> {
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

  public async dbExists(): Promise<boolean> {
    // if (db) {
    //   driver.listDatabases() will throw an error (database not found) if the db in question doesn't actually exist yet
    //   return (await this.driver.listDatabases()).includes(db)
    // }

    return await this.driver.exists()
  }

  public async clearDB(method: DBClearanceMethod = DBClearanceMethod.DELETE_DATA): Promise<void> {
    const dbExists = await this.dbExists()
    if (!dbExists) {
      return
    }

    if (method === DBClearanceMethod.RECREATE_DB) {
      try {
        await this.driver.dropDatabase(this.driver.name)
        await this.driver.createDatabase(this.driver.name)
        debugInfo(`DB ${this.driver.name} re-created`)
        return
      } catch (e) {
        throw new Error(`Failed to re-create DB ${this.driver.name}`)
      }
    }

    // TODO: graphs are not cleared yet ?

    (await this.driver.collections()).map(async (collection) => await collection.truncate())
    debugInfo(`DB ${this.driver.name} cleaned`)
  }

  public async createDBStructure(
    structure: DBStructure,
    clearDB?: DBClearanceMethod
  ): Promise<DBStructureResult> {
    if (!structure?.collections) {
      throw new Error('No DB structure specified')
    }

    const response: DBStructureResult = {
      database: undefined,
      collections: [],
      graphs: [],
      error: false
    }

    const dbExists = await this.dbExists()

    if (!dbExists) {
      debugInfo(`Database '${this.driver.name}' not found`)

      try {
        await this.system.createDatabase(this.driver.name)
        debugInfo(`Database '${this.driver.name}' created`)
        response.database = 'Database created'
      } catch (e) {
        response.database = 'Failed to create database'
        response.error = e
        debugInfo(`Failed to create database '${this.driver.name}'`)
        debugError(e)
        return response
      }
    } else {
      if (clearDB) {
        await this.clearDB(clearDB)
        debugInfo(`Database '${this.driver.name}' cleared with method ${clearDB}`)
        response.database = `Database cleared with method ${clearDB}`
      } else {
        debugInfo(`Database '${this.driver.name}' found`)
        response.database = 'Database found'
      }
    }

    const validation = await this.validateDBStructure(structure)

    if (validation.collections) {
      if (!response.collections) {
        response.collections = []
      }

      for (const entity of validation.collections) {
        if (!entity.exists) {
          try {
            await this.driver.collection(entity.name).create()
            response.collections.push(`Collection '${entity.name}' created`)
          } catch (e) {
            response.collections.push(`Failed to create collection '${entity.name}'`)
            response.error = e
            debugError(`Failed to create collection '${entity.name}'`)
            debugError(e)
            return response
          }
        } else {
          response.collections.push(`Collection '${entity.name}' found`)
        }
      }
    }

    if (validation.graphs) {
      if (!response.graphs) {
        response.graphs = []
      }

      for (const entity of validation.graphs) {
        if (!entity.exists) {
          const graph = structure.graphs
            ? structure.graphs.filter((graph) => graph.graph === entity.name)[0]
            : undefined

          if (graph?.edges && graph.edges.length > 0) {
            try {
              await this.driver.graph(graph.graph).create(graph.edges)
              response.graphs.push(`Graph '${entity.name}' created`)
            } catch (e) {
              response.graphs.push(`Failed to create graph '${entity.name}'`)
              response.error = e
              debugError(`Failed to create graph '${entity.name}'`)
              debugError(e)
              return response
            }
          }
        } else {
          response.graphs.push(`Graph '${entity.name}' found`)
        }
      }
    }

    return response
  }

  public async validateDBStructure(structure: DBStructure): Promise<DBStructureValidation> {
    const response: DBStructureValidation = {
      message: undefined,
      database: undefined,
      collections: [],
      graphs: []
    }

    if (!structure?.collections) {
      return response
    }

    const dbExists = await this.dbExists()
    if (!dbExists) {
      response.message = 'Database does not exist'
      response.database = { name: this.driver.name, exists: false }
      return response
    }

    response.database = { name: this.driver.name, exists: true }

    const collectionAvailability = await this.checkAvailableCollections(structure.collections)
    response.collections = collectionAvailability.all

    if (!collectionAvailability.allExist) {
      response.message = 'Required collections do not exist'
    }

    const graphAvailability = await this.checkAvailableGraphs(structure.graphs)
    response.graphs = graphAvailability.all

    if (!graphAvailability.allExist) {
      if (response.message) {
        response.message = response.message + ', and required graphs do not exist'
      } else {
        response.message = 'Required graphs do not exist'
      }
    }

    return response
  }

  /** @internal */
  private async checkAvailableCollections(collections: string[] | undefined): Promise<EntityAvailability> {
    const response: EntityAvailability = {
      all: [],
      missing: [],
      existing: [],
      allExist: false
    }

    if (!collections || collections.length === 0) {
      return response
    }

    response.existing = (await this.driver.listCollections()).map((c) => c.name)

    for (const collection of collections) {
      if (response.existing.includes(collection)) {
        response.all.push({ name: collection, exists: true })
      } else {
        response.all.push({ name: collection, exists: false })
        response.missing.push(collection)
      }
    }

    if (response.missing.length === 0) {
      response.allExist = true
    }

    return response
  }

  /** @internal */
  private async checkAvailableGraphs(graphs: string[] | GraphDefinition[] | undefined): Promise<EntityAvailability> {
    const response: EntityAvailability = {
      all: [],
      missing: [],
      existing: [],
      allExist: false
    }

    if (!graphs || graphs.length === 0) {
      return response
    }

    response.existing = (await this.driver.listGraphs()).map((c) => c.name)

    for (const graph of toGraphNames(graphs)) {
      if (response.existing.includes(graph)) {
        response.all.push({ name: graph, exists: true })
      } else {
        response.all.push({ name: graph, exists: false })
        response.missing.push(graph)
      }
    }

    if (response.missing.length === 0) {
      response.allExist = true
    }

    return response
  }
}
