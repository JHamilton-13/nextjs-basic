// Prints (does not run) the SQL that copies a Cockpit project's address and builder contact onto one project here.
// Usage: npx tsx packages/domain/scripts/cockpit-project-sql.ts <project uuid> <cockpit-record.json>
// The JSON is one Cockpit Project record (fields: name, builder, address, estimateDetails). Only address, builder name and contact email are read.
// Review the printed statement; it is applied to the database only after the owner says so.
import { readFileSync } from "node:fs";
import { mapCockpitProject, projectContactSql } from "../src";

const [id, file] = process.argv.slice(2);
if (!id || !file) { console.error("usage: cockpit-project-sql.ts <project uuid> <cockpit-record.json>"); process.exit(2); }
const mapped = mapCockpitProject(JSON.parse(readFileSync(file, "utf8")));
console.log(projectContactSql(id, mapped));
if (!mapped.preparedForEmail) console.error("note: the record has no valid Contact Email, so prepared_for_email will be NULL");
if (!mapped.address) console.error("note: the record has no address, so address will be NULL (an existing address would be overwritten)");
