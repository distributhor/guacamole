//
// Run with: ts-node test/scripts/play.ts
//

import * as path from 'path'
import * as dotenv from 'dotenv'
// import { GeneratedAqlQuery } from "arangojs/aql";
import { ArangoDB } from '../../src/index'

dotenv.config({ path: path.join(__dirname, '../../integration/.env') })

// const fetchUserByName = (name: string): GeneratedAqlQuery => {
//   return aql`
//     FOR d IN user FILTER d.name LIKE ${name} RETURN d
//   `;
// };

void (async function () {
  try {
    const db = new ArangoDB({
      databaseName: process.env.ARANGO_TEST_DB1_NAME,
      url: process.env.ARANGO_TEST_DB_URI
    })

    // const johnByQuery = await db.queryOne(fetchUserByName("John"));
    // const johnByKey = await db.driver.collection("user").document(johnByQuery._key);

    // console.log(johnByQuery);
    // console.log(johnByKey);

    // const query = toConstraintValidationQueryV2({
    //   collection: "users",
    //   constraints: [{ unique: { key: "username", value: "chiefdoper" } }],
    // });

    // console.log(query);

    const result1 = await db.validateUniqueConstraint({
      collection: 'users',
      constraints: [{ unique: { name: 'username', value: 'chiefdoper' } }]
    })

    console.log(result1)

    const result2 = await db.validateUniqueConstraint({
      collection: 'users',
      constraints: [{ unique: { name: 'username', value: 'thetrain' } }]
    })

    console.log(result2)

    // const result3 = await db.validateUniqueConstraint({
    //   collection: "users",
    //   constraints: [{ unique: { key: "username", value: "thetrain" } }, { unique: { key: "name", value: "Lance" } }],
    // });

    // console.log(result3);

    // const result4 = await db.validateUniqueConstraint({
    //   collection: "users",
    //   constraints: [{ unique: { key: "username", value: "thetrain" } }, { unique: { key: "name", value: "Thomas" } }],
    // });

    // console.log(result4);
  } catch (err) {
    console.log(err.response.body)
  }
})()
