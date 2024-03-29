/* eslint-disable jest/no-conditional-expect */
import * as path from 'path'
import * as dotenv from 'dotenv'
import { aql } from 'arangojs/aql'
import { ArrayCursor } from 'arangojs/cursor'
import { ArangoConnection } from '../../src/index'
import { DBStructure, QueryResult } from '../../src/types'

import cyclists from './cyclists.json'
import teams from './teams.json'

dotenv.config({ path: path.join(__dirname, '.env') })

const db1 = 'guacamole-test1'
const db2 = 'guacamole-test2'

const dbAdminUser = process.env.GUACAMOLE_TEST_DB_USER ?? 'root'
const dbAdminPassword = process.env.GUACAMOLE_TEST_DB_PASSWORD ?? 'letmein'

// TODO: want to use a different restricted user for some tests in the future
// const dbRestrictedUser = dbAdminUser // 'guacamole'
// const dbRestrictePassword = dbAdminPassword // 'letmein'

const CONST = {
  userCollection: 'cyclists',
  groupCollection: 'teams',
  userToGroupEdge: 'team_members',
  groupMembershipGraph: 'team_membership'
}

const dbStructure: DBStructure = {
  collections: [CONST.userCollection, CONST.groupCollection],
  graphs: [
    {
      graph: CONST.groupMembershipGraph,
      edges: [
        {
          collection: CONST.userToGroupEdge,
          from: CONST.userCollection,
          to: CONST.groupCollection
        }
      ]
    }
  ]
}

const conn = new ArangoConnection({
  databaseName: db1,
  url: process.env.GUACAMOLE_TEST_DB_URI,
  auth: { username: dbAdminUser, password: dbAdminPassword }
})

describe('Guacamole Integration Tests', () => {
  test('Connection and instance management', async () => {
    expect(conn.db(db1).name).toEqual(db1)
    expect(conn.system.name).toEqual('_system')
    expect(conn.listConnections()).toEqual([db1])

    conn.db(db1) // should NOT create additional instance, because it already exists
    conn.db(db2) // should create an additional instance, because it doesn't exist

    expect(conn.db(db1).name).toEqual(db1)
    expect(conn.db(db2).name).toEqual(db2)
    expect(conn.listConnections()).toEqual([db1, db2])
  })

  test('Create database', async () => {
    // confirm that at least one database is already present
    const dbs = await conn.system.listDatabases()
    expect(dbs.length).toBeGreaterThanOrEqual(1)

    let db1Exists = await conn.db(db1).dbExists()
    let db2Exists = await conn.db(db2).dbExists()

    expect(db1Exists).toBeFalsy()
    expect(db2Exists).toBeFalsy()

    await conn.system.createDatabase(db1)

    db1Exists = await conn.db(db1).dbExists()
    db2Exists = await conn.db(db2).dbExists()

    expect(db1Exists).toBeTruthy()
    expect(db2Exists).toBeFalsy()
  })

  test('Create database structure and test multi-driver behaviour', async () => {
    // create structure for existing DB
    const result1 = await conn.db(db1).createDBStructure(dbStructure)

    // create structure for non-existing DB
    const result2 = await conn.db(db2).createDBStructure(dbStructure)

    expect(result1.database).toEqual('Database found')
    expect(result1.graphs).toEqual(expect.arrayContaining([`Graph '${CONST.groupMembershipGraph}' created`]))
    expect(result1.collections).toEqual(
      expect.arrayContaining([
        `Collection '${CONST.userCollection}' created`,
        `Collection '${CONST.groupCollection}' created`
      ])
    )

    // TODO: confirm that removal and re-creation of collection doesn't affect dependent graph ?
    expect(result2.database).toEqual('Database created')
    expect(result2.graphs).toEqual(expect.arrayContaining([`Graph '${CONST.groupMembershipGraph}' created`]))
    expect(result2.collections).toEqual(
      expect.arrayContaining([
        `Collection '${CONST.userCollection}' created`,
        `Collection '${CONST.groupCollection}' created`
      ])
    )

    // confirm non-existent DB was created
    const db2Exists = await conn.db(db2).dbExists()
    expect(db2Exists).toBeTruthy()

    // check that expected collections exist and that different drivers behave as expected
    const collecionList1 = await conn.driver(db1).listCollections()
    const collecionList2 = await conn.driver(db2).listCollections()

    expect(collecionList1.length).toEqual(3)
    expect(collecionList2.length).toEqual(3)

    const usersCollectionOnSystemDB1 = await conn.system.collection(CONST.userCollection).exists()

    const usersCollectionExist = await conn.db(db1).col(CONST.userCollection).exists()
    const groupsCollectionExist = await conn.db(db1).col(CONST.groupCollection).exists()
    const userGroupsCollectionExist = await conn.db(db1).col(CONST.userToGroupEdge).exists()

    expect(usersCollectionOnSystemDB1).toBeFalsy()
    expect(usersCollectionExist).toBeTruthy()
    expect(groupsCollectionExist).toBeTruthy()
    expect(userGroupsCollectionExist).toBeTruthy()

    // remove a collection and recreate the structure
    await conn.driver(db2).collection(CONST.userCollection).drop()
    const usersCollectionExist2 = await conn.db(db2).col(CONST.userCollection).exists()
    expect(usersCollectionExist2).toBeFalsy()

    const result3 = await conn.db(db2).createDBStructure(dbStructure)

    expect(result3.database).toEqual('Database found')
    expect(result3.graphs).toEqual(expect.arrayContaining([`Graph '${CONST.groupMembershipGraph}' found`]))
    expect(result3.collections).toEqual(
      expect.arrayContaining([
        `Collection '${CONST.userCollection}' created`,
        `Collection '${CONST.groupCollection}' found`
      ])
    )

    const usersCollectionExist3 = await conn.db(db2).col(CONST.userCollection).exists()
    expect(usersCollectionExist3).toBeTruthy()

    // confirm that empty array values do not break anything, ie, that they
    // are essentially unhandled and nothing happens, so it's a safe operation
    const dbStructureWithEmptyArrays: DBStructure = {
      collections: [],
      graphs: [
        {
          graph: 'xyz',
          edges: []
        }
      ]
    }

    const result4 = await conn.db(db2).createDBStructure(dbStructureWithEmptyArrays)

    const collectionLength = result4.collections ? result4.collections.length : 99
    const graphLength = result4.graphs ? result4.graphs.length : 99

    expect(result4.database).toEqual('Database found')
    expect(collectionLength).toEqual(0)
    expect(graphLength).toEqual(0)
  })

  test('Validate database structure', async () => {
    if (dbStructure.collections) {
      dbStructure.collections.push('abc')
    }

    if (dbStructure.graphs) {
      dbStructure.graphs.push({
        graph: 'def',
        edges: []
      })
    }

    const result = await conn.db(db1).validateDBStructure(dbStructure)

    expect(result.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: CONST.userCollection, exists: true }),
        expect.objectContaining({ name: CONST.groupCollection, exists: true }),
        expect.objectContaining({ name: 'abc', exists: false })
      ])
    )

    expect(result.graphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: CONST.groupMembershipGraph, exists: true }),
        expect.objectContaining({ name: 'def', exists: false })
      ])
    )
  })

  test('Import test data', async () => {
    const result1 = await conn.db(db1).create(CONST.userCollection, cyclists)
    const result2 = await conn.db(db1).create(CONST.groupCollection, teams)

    expect(result1.length).toEqual(25)
    expect(result2.length).toEqual(16)
  })

  test('Unique constraint validation', async () => {
    // should be case insensitive PT1
    const result1 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [{ unique: { name: 'nickname', value: 'Chief Doper' } }]
    })

    expect(result1.violatesUniqueConstraint).toBeTruthy()

    // should be case insensitive PT2
    const result1DifferentCase1 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [{ unique: { name: 'nickname', value: 'Chief DOPER' } }]
    })

    expect(result1DifferentCase1.violatesUniqueConstraint).toBeTruthy()

    // should be case sensitive
    const result1DifferentCase2 = await conn.db(db1).uniqueConstraintValidation({
      caseInsensitive: true,
      collection: CONST.userCollection,
      constraints: [{ unique: { name: 'nickname', value: 'Chief DOPER' } }]
    })

    expect(result1DifferentCase2.violatesUniqueConstraint).toBeFalsy()

    const result2 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [{ unique: { name: 'nickname', value: 'Tornado' } }]
    })

    expect(result2.violatesUniqueConstraint).toBeFalsy()

    const result3 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        { unique: { name: 'nickname', value: 'Tornado' } },
        { unique: { name: 'surname', value: 'Armstrong' } }
      ]
    })

    expect(result3.violatesUniqueConstraint).toBeTruthy()

    const result3DifferentCase1 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        { unique: { name: 'nickname', value: 'TORNADO' } },
        { unique: { name: 'surname', value: 'ArmSTRONG' } }
      ]
    })

    expect(result3DifferentCase1.violatesUniqueConstraint).toBeTruthy()

    const result3DifferentCase2 = await conn.db(db1).uniqueConstraintValidation({
      caseInsensitive: true,
      collection: CONST.userCollection,
      constraints: [
        { unique: { name: 'nickname', value: 'TORNADO' } },
        { unique: { name: 'surname', value: 'ArmSTRONG' } }
      ]
    })

    expect(result3DifferentCase2.violatesUniqueConstraint).toBeFalsy()

    const result4 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        { unique: { name: 'nickname', value: 'Tornado' } },
        { unique: { name: 'surname', value: 'Voeckler' } }
      ]
    })

    expect(result4.violatesUniqueConstraint).toBeFalsy()

    const result5 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        {
          composite: [
            { name: 'name', value: 'Thomas' },
            { name: 'surname', value: 'de Ghent' }
          ]
        }
      ]
    })

    expect(result5.violatesUniqueConstraint).toBeTruthy()

    const result5DifferentCase1 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        {
          composite: [
            { name: 'name', value: 'THOMAS' },
            { name: 'surname', value: 'DE Ghent' }
          ]
        }
      ]
    })

    expect(result5DifferentCase1.violatesUniqueConstraint).toBeTruthy()

    const result5DifferentCase2 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      caseInsensitive: true,
      constraints: [
        {
          composite: [
            { name: 'name', value: 'THOMAS' },
            { name: 'surname', value: 'DE Ghent' }
          ]
        }
      ]
    })

    expect(result5DifferentCase2.violatesUniqueConstraint).toBeFalsy()

    const result6 = await conn.db(db1).uniqueConstraintValidation({
      collection: CONST.userCollection,
      constraints: [
        {
          composite: [
            { name: 'name', value: 'Thomas' },
            { name: 'surname', value: 'Voeckler' }
          ]
        }
      ]
    })

    expect(result6.violatesUniqueConstraint).toBeFalsy()
  })

  test('CRUD', async () => {
    const result1A = await conn.db(db1).create(CONST.userCollection, {
      name: 'Daryl',
      surname: 'Impey',
      country: 'South Africa',
      speciality: 'All Rounder',
      _secret: 'Rusks',
      results: {
        2014: ['1st, Tour of Alberta', '1st, SA Champs TT', '2nd, SA Champs Road Race'],
        2015: ['2nd, Vuelta a La Rioja'],
        2017: ['1st, 94.7 Cycle Challenge'],
        2018: ['1st, SA Champs TT', '1st, SA Champs Road Race', '1st, Tour Down Under']
      },
      rating: {
        sprint: 8,
        climb: 7,
        timetrial: 8,
        punch: 8,
        descend: 7
      },
      favoriteRoads: {
        SouthAfrica: {
          CapeTown: 'Chapmans Peak'
        },
        Portugal: {
          Lisbon: 'Sintra'
        },
        France: 'Col du Galibier'
      }
    })

    expect(result1A).toBeDefined()
    expect(result1A[0]._key).toBeDefined()

    const result1B = await conn.db(db1).read(CONST.userCollection, { id: result1A[0]._key })

    expect(result1B.name).toEqual('Daryl')
    expect(result1B.surname).toEqual('Impey')
    expect(result1B._secret).toEqual('Rusks')
    expect(result1B.results[2018].length).toEqual(3)
    expect(result1B.rating.timetrial).toEqual(8)

    // interface Person {
    //   name: string
    // }
    // const result1C = await conn.db(db1).read<Person>(

    const result1C = await conn.db(db1).read(CONST.userCollection, { id: result1A[0]._key }, { trimPrivateProps: true })

    expect(result1C.name).toEqual('Daryl')
    expect(result1C.surname).toEqual('Impey')
    expect(result1C._secret).toBeUndefined()
    expect(result1C.results[2018].length).toEqual(3)
    expect(result1C.rating.timetrial).toEqual(8)

    const result1D = await conn.db(db1).read(CONST.userCollection, { id: 'Impey', identifier: 'surname' })

    expect(result1D.name).toEqual('Daryl')
    expect(result1D.surname).toEqual('Impey')
    expect(result1D._secret).toEqual('Rusks')
    expect(result1D.results[2018].length).toEqual(3)
    expect(result1D.rating.timetrial).toEqual(8)

    const result1E = await conn.db(db1).read(CONST.userCollection, { id: 'Impey', identifier: 'surname' }, { trimPrivateProps: true })

    expect(result1E.name).toEqual('Daryl')
    expect(result1E.surname).toEqual('Impey')
    expect(result1E._secret).toBeUndefined()
    expect(result1E.results[2018].length).toEqual(3)
    expect(result1E.rating.timetrial).toEqual(8)

    const result2A = await conn.db(db1).create(CONST.userCollection, {
      name: 'Cadel',
      surname: 'Evans',
      country: 'Australia',
      speciality: 'GC',
      _secret: 'Smiling',
      results: {
        2010: ['1st, La Flèche Wallonne', "5th, Giro d'Italia", '6th, Tour Down Under'],
        2015: ['1st, Tour de France', '1st, Tirreno–Adriatico', '1st Tour de Romandie'],
        2012: ['7th, Tour de France'],
        2013: ["3rd, Giro d'Italia"]
      },
      rating: {
        sprint: 6,
        climb: 8,
        timetrial: 9,
        punch: 8,
        descend: 7
      }
    }
      // { omit: { trimPrivateProps: true } }
    )

    expect(result2A).toBeDefined()
    expect(result2A[0]._key).toBeDefined()

    const result2B = await conn.db(db1).read(CONST.userCollection, { id: result2A[0]._key })

    expect(result2B.name).toEqual('Cadel')
    expect(result2B.surname).toEqual('Evans')
    // expect(result2B._secret).toBeUndefined()
    expect(result2B.results[2012].length).toEqual(1)
    expect(result2B.rating.sprint).toEqual(6)

    const result2C = await conn.db(db1).update(CONST.userCollection, {
      id: result2A[0]._key,
      data: {
        nickname: "G'day Mate",
        speciality: 'All Rounder',
        results: { 2012: ['3rd, Critérium du Dauphiné'] },
        rating: { sprint: 7 }
      }
    })

    expect(result2C[0]._key).toBeDefined()

    const result2D = await conn.db(db1).read(CONST.userCollection, { id: result2A[0]._key })

    expect(result2D.name).toEqual('Cadel')
    expect(result2D.surname).toEqual('Evans')
    expect(result2D.nickname).toEqual("G'day Mate")
    expect(result2D.speciality).toEqual('All Rounder')
    expect(result2D.results['2012']).toEqual(expect.arrayContaining(['3rd, Critérium du Dauphiné']))
    expect(result2D.results['2013']).toEqual(expect.arrayContaining(["3rd, Giro d'Italia"]))
    expect(result2D.rating).toEqual(
      expect.objectContaining({
        sprint: 7,
        climb: 8,
        timetrial: 9,
        punch: 8,
        descend: 7
      })
    )

    const result2E = await conn.db(db1).update(CONST.userCollection, {
      identifier: 'surname',
      id: 'Evans',
      data: {
        nickname: 'Too Nice',
        speciality: 'GC',
        results: { 2009: ['1st, UCI Road Race World Champs'] },
        rating: { solo: 8 }
      }
    })

    expect(result2E).toBeDefined()
    expect(Array.isArray(result2E)).toBeTruthy()
    expect(result2E.length).toEqual(1)
    expect(result2E[0]._key).toBeDefined()

    const result2F = await conn.db(db1).read(CONST.userCollection, { id: result2A[0]._key })

    expect(result2F.name).toEqual('Cadel')
    expect(result2F.surname).toEqual('Evans')
    expect(result2F.nickname).toEqual('Too Nice')
    expect(result2F.speciality).toEqual('GC')
    expect(result2F.results['2012']).toEqual(expect.arrayContaining(['3rd, Critérium du Dauphiné']))
    expect(result2F.results['2013']).toEqual(expect.arrayContaining(["3rd, Giro d'Italia"]))
    expect(result2F.results['2009']).toEqual(expect.arrayContaining(['1st, UCI Road Race World Champs']))
    expect(result2F.rating).toEqual(
      expect.objectContaining({
        sprint: 7,
        climb: 8,
        timetrial: 9,
        punch: 8,
        descend: 7,
        solo: 8
      })
    )

    const result2G = await conn.db(db1).read(CONST.userCollection, { id: 'Evans', identifier: 'surname' })

    expect(result2G.name).toEqual('Cadel')
    expect(result2G.surname).toEqual('Evans')

    const result2H = await conn.db(db1).delete(CONST.userCollection, { id: result2A[0]._key })

    expect(result2H[0]._key).toBeDefined()

    const result2I = await conn.db(db1).read(CONST.userCollection, { id: result2A[0]._key })

    expect(result2I).toBeNull()

    const result2J = await conn.db(db1).read(CONST.userCollection, { id: 'Evans', identifier: 'surname' })

    expect(result2J).toBeNull()

    const result3A = await conn.db(db1).create(CONST.userCollection, {
      name: 'Thomas',
      surname: 'Voeckler',
      country: 'France'
    })

    expect(result3A).toBeDefined()
    expect(result3A[0]._key).toBeDefined()

    const result3B = await conn.db(db1).read(CONST.userCollection, { id: result3A[0]._key })

    expect(result3B.name).toEqual('Thomas')
    expect(result3B.surname).toEqual('Voeckler')

    const result3C = await conn.db(db1).delete(CONST.userCollection, { id: 'Voeckler', identifier: 'surname' })

    expect(result3C).toBeDefined()
    expect(Array.isArray(result3C)).toBeTruthy()
    expect(result3C.length).toEqual(1)
    expect(result3C[0]._key).toBeDefined()

    const result3D = await conn.db(db1).read(CONST.userCollection, { id: result3A[0]._key })

    expect(result3D).toBeNull()

    const result4A = await conn.db(db1).update(CONST.userCollection, {
      identifier: 'speciality',
      id: 'Time Trial',
      data: {
        rating: { timetrial: 9 }
      }
    })

    expect(result4A).toBeDefined()
    expect(Array.isArray(result4A)).toBeTruthy()
    expect(result4A.length).toEqual(3)
    expect(result4A[0]._key).toBeDefined()

    const result4B = (await conn.db(db1)
      .fetchByPropertyValue(CONST.userCollection, { name: 'speciality', value: 'Time Trial' })) as QueryResult

    expect(result4B.data.length).toEqual(3)
    expect(result4B.data[0].rating.timetrial).toEqual(9)

    const result4BWithLimit1 = (await conn.db(db1)
      .fetchByPropertyValue(
        CONST.userCollection,
        { name: 'speciality', value: 'Time Trial' },
        { limit: 2, sortBy: 'name', sortOrder: 'descending' }
      )) as QueryResult

    const result4BWithLimit2 = (await conn.db(db1)
      .fetchByPropertyValue(
        CONST.userCollection,
        { name: 'speciality', value: 'Time Trial' },
        { limit: 2, offset: 1, sortBy: 'name', sortOrder: 'descending' }
      )) as QueryResult

    expect(result4BWithLimit1.data.length).toEqual(2)
    expect(result4BWithLimit2.size).toEqual(2)
    expect(result4BWithLimit2.total).toEqual(3)

    expect(result4BWithLimit1.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Tony' }),
        expect.objectContaining({ name: 'Rohan' })
      ])
    )

    expect(result4BWithLimit2.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Rohan' }),
        expect.objectContaining({ name: 'Fabian' })
      ])
    )

    const result5A = await conn.db(db1).delete(CONST.userCollection, { id: 'Break Aways', identifier: 'speciality' })

    expect(result5A).toBeDefined()
    expect(Array.isArray(result5A)).toBeTruthy()
    expect(result5A.length).toEqual(1)

    const result5B = (await conn.db(db1).fetchByPropertyValue(CONST.userCollection, { name: 'speciality', value: 'Break Aways' })) as QueryResult

    expect(result5B.data.length).toEqual(0)
  })

  test('fetchByPropertyValue', async () => {
    const result1A = (await conn.db(db1)
      .fetchByPropertyValue(CONST.userCollection, { name: 'name', value: 'Daryl' })) as QueryResult

    expect(result1A.data.length).toEqual(1)

    const result1B = (await conn.db(db1)
      .fetchByPropertyValue(CONST.userCollection, { name: 'favoriteRoads.Portugal.Lisbon', value: 'Sintra' })) as QueryResult

    expect(result1B.data.length).toEqual(1)

    const result1C = (await conn.db(db1)
      .fetchMatchingAllPropertyValues(CONST.userCollection, [
        { name: 'favoriteRoads.SouthAfrica.CapeTown', value: 'Chapmans Peak' },
        { name: 'favoriteRoads.Portugal.Lisbon', value: 'Sintra' }
      ])) as QueryResult

    expect(result1C.data.length).toEqual(1)

    const result1D = (await conn.db(db1)
      .fetchMatchingAllPropertyValues(CONST.userCollection, [
        { name: 'favoriteRoads.SouthAfrica.CapeTown', value: 'Chappies' },
        { name: 'favoriteRoads.Portugal.Lisbon', value: 'Sintra' }
      ])) as QueryResult

    expect(result1D.data.length).toEqual(0)

    const result1E = (await conn.db(db1)
      .fetchMatchingAnyPropertyValue(CONST.userCollection, [
        { name: 'favoriteRoads.SouthAfrica.CapeTown', value: 'Chappies' },
        { name: 'favoriteRoads.Portugal.Lisbon', value: 'Sintra' }
      ])) as QueryResult

    expect(result1E.data.length).toEqual(1)
  })

  test('returnAll, returnOne', async () => {
    const result1A = await conn
      .db(db1)
      .returnAll(aql`FOR d IN ${conn.col(db1, CONST.userCollection)} FILTER d.speciality LIKE "Time Trial" RETURN d`)

    expect(result1A.data.length).toEqual(3)
    expect(result1A.data[0].surname).toBeDefined()

    const result1ALiteral = await conn
      .db(db1)
      .returnAll(`FOR d IN ${CONST.userCollection} FILTER d.speciality LIKE "Time Trial" RETURN d`)

    expect(result1ALiteral.data.length).toEqual(3)
    expect(result1ALiteral.data[0].surname).toBeDefined()

    const result1B = (await conn
      .db(db1)
      .fetchByPropertyValue(CONST.userCollection, { name: 'speciality', value: 'Time Trial' })) as QueryResult

    expect(result1B.data.length).toEqual(3)
    expect(result1B.data[0].name).toBeDefined()
    expect(result1B.data[0].surname).toBeDefined()
    expect(result1B.data[0]._key).toBeDefined()

    const result1C = (await conn.db(db1).fetchByPropertyValue(
      CONST.userCollection,
      { name: 'speciality', value: 'Time Trial' },
      {
        trimPrivateProps: true
      }
    )) as QueryResult

    expect(result1C.data.length).toEqual(3)
    expect(result1C.data[0].name).toBeDefined()
    expect(result1C.data[0].surname).toBeDefined()
    expect(result1C.data[0]._key).toBeDefined()

    const result1D = (await conn.db(db1).fetchByPropertyValue(
      CONST.userCollection,
      { name: 'speciality', value: 'Time Trial' },
      {
        trimPrivateProps: true
      }
    )) as QueryResult

    expect(result1D.data.length).toEqual(3)
    expect(result1D.data[0].name).toBeDefined()
    expect(result1D.data[0].surname).toBeDefined()
    expect(result1D.data[0]._key).toBeDefined()

    const result1E = (await conn.db(db1).fetchByPropertyValue(
      CONST.userCollection,
      { name: 'speciality', value: 'Time Trial' },
      { returnCursor: true }
    )) as ArrayCursor

    expect(result1E instanceof ArrayCursor).toBeTruthy()
    const allDocs = await result1E.all()
    expect(allDocs[0].surname).toBeDefined()

    const result2A = await conn.db(db1)
      .returnAll(aql`FOR d IN ${conn.col(db1, CONST.userCollection)} FILTER d.speciality LIKE "Trail Running" RETURN d`)

    expect(result2A.data).toBeDefined()
    expect(Array.isArray(result2A.data)).toBeTruthy()
    expect(result2A.data.length).toEqual(0)

    const result2B = (await conn.db(db1).fetchByPropertyValue(CONST.userCollection, {
      name: 'speciality',
      value: 'Trail Running'
    })) as QueryResult

    expect(result2B.data).toBeDefined()
    expect(Array.isArray(result2B.data)).toBeTruthy()
    expect(result2B.data.length).toEqual(0)

    const result3A = await conn.db(db1)
      .returnOne(aql`FOR d IN ${conn.col(db1, CONST.userCollection)} FILTER d.speciality LIKE "Trail Running" RETURN d`)

    expect(result3A).toBeNull()

    const result3B = await conn.db(db1)
      .fetchOneByPropertyValue(CONST.userCollection, { name: 'speciality', value: 'Trail Running' })

    expect(result3B).toBeNull()

    const result4A = await conn.db(db1)
      .returnOne(aql`FOR d IN ${conn.col(db1, CONST.userCollection)} FILTER d.speciality LIKE "Time Trial" RETURN d`)

    expect(result4A).toBeDefined()
    expect(result4A.surname).toBeDefined()

    const result4B = await conn.db(db1)
      .fetchOneByPropertyValue(CONST.userCollection, { name: 'speciality', value: 'Time Trial' })

    expect(result4B).toBeDefined()
    expect(result4B.surname).toBeDefined()

    const result5A = await conn.db(db1)
      .returnOne(aql`FOR d IN ${conn.col(db1, CONST.userCollection)} FILTER d.surname LIKE "Impey" RETURN d`)

    expect(result5A).toBeDefined()
    expect(result5A.name).toEqual('Daryl')

    const result5B = await conn.db(db1)
      .fetchOneByPropertyValue(CONST.userCollection, { name: 'surname', value: 'Impey' })

    expect(result5B).toBeDefined()
    expect(result5B.name).toEqual('Daryl')
    expect(result5B.surname).toEqual('Impey')
    expect(result5B._secret).toEqual('Rusks')
    expect(result5B._key).toBeDefined()

    const result5C = await conn.db(db1)
      .fetchOneByPropertyValue(
        CONST.userCollection,
        { name: 'surname', value: 'Impey' },
        { trimPrivateProps: true }
      )

    expect(result5C).toBeDefined()
    expect(result5C.name).toEqual('Daryl')
    expect(result5C.surname).toEqual('Impey')
    expect(result5C._secret).toBeUndefined()
    expect(result5C._key).toBeDefined()

    const result5D = await conn.db(db1)
      .fetchOneByPropertyValue(
        CONST.userCollection,
        { name: 'surname', value: 'Impey' },
        { trimPrivateProps: true }
      )

    expect(result5D).toBeDefined()
    expect(result5D.name).toEqual('Daryl')
    expect(result5D.surname).toEqual('Impey')
    expect(result5B._secret).toEqual('Rusks')
    expect(result5D._key).toBeDefined()

    const result6A = (await conn.db(db1).fetchMatchingAllPropertyValues(CONST.userCollection, [
      { name: 'country', value: 'Belgium' },
      { name: 'speciality', value: 'Classics' }
    ])) as QueryResult

    expect(result6A.data.length).toEqual(2)
    expect(result6A.data[0].name === 'Wout' || result6A.data[0].name === 'Tim').toBeTruthy()
    expect(result6A.data[1].surname === 'van Aert' || result6A.data[1].surname === 'Wellens').toBeTruthy()

    const result6B = (await conn.db(db1).fetchMatchingAllPropertyValues(CONST.userCollection, [
      { name: 'country', value: 'UK' },
      { name: 'speciality', value: 'Classics' }
    ])) as QueryResult

    expect(result6B.data.length).toEqual(0)

    const result7A = await conn.db(db1).fetchOneByCompositeValue(CONST.userCollection, [
      { name: 'country', value: 'Belgium' },
      { name: 'speciality', value: 'Classics' }
    ])

    expect(result7A.surname === 'van Aert' || result7A.surname === 'Wellens').toBeTruthy()

    const result7B = await conn.db(db1).fetchOneByCompositeValue(CONST.userCollection, [
      { name: 'name', value: 'Jan' },
      { name: 'surname', value: 'Ullrich' }
    ])

    expect(result7B.surname).toEqual('Ullrich')

    const result7C = await conn.db(db1).fetchOneByCompositeValue(CONST.userCollection, [
      { name: 'name', value: 'Jan' },
      { name: 'surname', value: 'Armstrong' }
    ])

    expect(result7C).toBeNull()
  })

  test('fetchByFilterCriteria', async () => {
    const result1A = await conn.db(db1)
      .fetchByFilterCriteria(CONST.userCollection, 'name == "Lance" || name == "Chris"') as QueryResult

    expect(result1A.data.length).toEqual(2)
    expect(result1A.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Lance', surname: 'Armstrong' }),
        expect.objectContaining({ name: 'Chris', surname: 'Froome' })
      ])
    )

    const result1B = await conn.db(db1)
      .fetchByFilterCriteria(CONST.userCollection, 'name == "Lance" || name == "Chris"', {
        returnCursor: true
      }) as ArrayCursor

    expect(result1B instanceof ArrayCursor).toBeTruthy()

    const result2A = await conn.db(db1)
      .fetchByFilterCriteria(CONST.userCollection, 'country == "Italy" && speciality == "General Classification"') as QueryResult

    expect(result2A.data.length).toEqual(2)
    expect(result2A.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Ivan', surname: 'Basso' }),
        expect.objectContaining({ name: 'Vincenzo', surname: 'Nibali' })
      ])
    )
  })

  test('findWhereFieldsMatch', async () => {
    const result1A = await conn.db(db1)
      // 'FOR d IN cyclists FILTER ( LIKE(d.name, "%lance%", true) || LIKE(d.name, "%chris%", true) ) RETURN d',
      // 'FOR d IN cyclists FILTER ( LIKE(d.name, "%lance%", true) || LIKE(d.name, "%chris%", true) || LIKE(d.surname, "%lance%", true) || LIKE(d.surname, "%chris%", true) ) RETURN d'
      .findWhereAnyPropertyContains(CONST.userCollection, 'name', ['lance', 'chris']) as QueryResult

    const result2A = await conn.db(db1)
      .findWhereAnyPropertyContains(CONST.userCollection, 'name', ['mar']) as QueryResult

    expect(result1A.data.length).toEqual(2)
    expect(result1A.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Lance', surname: 'Armstrong' }),
        expect.objectContaining({ name: 'Chris', surname: 'Froome' })
      ])
    )

    expect(result2A.data.length).toEqual(3)
    expect(result2A.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Marco', surname: 'Pantani' }),
        expect.objectContaining({ name: 'Mark', surname: 'Cavendish' }),
        expect.objectContaining({ name: 'Marc', surname: 'Soler' })
      ])
    )
  })

  test('Delete database', async () => {
    expect.assertions(5)

    await conn.system.dropDatabase(db1)
    await conn.system.dropDatabase(db2)

    const testDB1Exists = await conn.db(db1).dbExists()
    const db2Exists = await conn.db(db2).dbExists()

    expect(testDB1Exists).toBeFalsy()
    expect(db2Exists).toBeFalsy()

    try {
      await conn.system.dropDatabase(db1)
    } catch (e) {
      expect(e.response.body.code).toEqual(404)
      expect(e.response.body.errorNum).toEqual(1228)
      expect(e.response.body.errorMessage).toEqual('database not found')
    }
  })
})
