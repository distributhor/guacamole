import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.join(__dirname, '.env') })

export const dbName = 'guacamole_test'
export const dbName2 = 'guacamole_test2'
export const dbUrl = process.env.GUACAMOLE_TEST_DB_URI ?? ''
export const dbAdminUser = process.env.GUACAMOLE_TEST_DB_USER ?? 'root'
export const dbAdminPassword = process.env.GUACAMOLE_TEST_DB_PASSWORD ?? 'letmein'

export const CONST = {
  cyclistCollection: 'cyclists',
  teamCollection: 'teams',
  raceCollection: 'races',
  teamMembershipEdge: 'team_membership',
  teamMembershipGraph: 'team_membership_graph',
  raceAttendanceEdge: 'race_attendance',
  raceAttendanceGraph: 'race_attendance_graph',
  altCyclistCollection: 'cyclists_alt'
}

export const VAR = {
  dbName,
  dbName2,
  dbUrl,
  dbAdminUser,
  dbAdminPassword,
  ...CONST
}
