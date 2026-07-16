import db from "../config/db.js";

async function cleanup() {
  console.log("US VISA KPI SYNCED EMPLOYEE ID CLEANUP STARTED");

  const [result] = await db.query(`
    UPDATE us_visa_kpi_employees
    SET
      employee_id = NULL,
      employee_number = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE account_name LIKE '%US Visa%'
      AND (
        employee_id = employee_uid
        OR employee_number = employee_uid
        OR employee_id REGEXP '^[a-z0-9]+(_[a-z0-9]+)+$'
        OR employee_number REGEXP '^[a-z0-9]+(_[a-z0-9]+)+$'
      )
      AND (
        employee_id IS NULL
        OR employee_id NOT REGEXP '^SIB[- ]?[0-9]+'
      )
  `);

  console.log(`Cleaned rows: ${result.affectedRows || 0}`);
  console.log("US VISA KPI SYNCED EMPLOYEE ID CLEANUP COMPLETED");
  process.exit(0);
}

cleanup().catch((error) => {
  console.error("US VISA KPI SYNCED EMPLOYEE ID CLEANUP FAILED", error);
  process.exit(1);
});
