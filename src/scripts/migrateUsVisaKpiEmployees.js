import db from "../config/db.js";

async function migrateUsVisaKpiEmployees() {
  console.log("US VISA KPI EMPLOYEE SETTINGS MIGRATION STARTED");

  await db.query(`
    CREATE TABLE IF NOT EXISTS us_visa_kpi_employees (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      employee_uid VARCHAR(100) NOT NULL,
      employee_id VARCHAR(100) NULL,
      employee_number VARCHAR(100) NULL,
      employee_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      position VARCHAR(255) NULL,
      department VARCHAR(255) NULL,
      team VARCHAR(255) NULL,
      supervisor VARCHAR(255) NULL,
      account_name VARCHAR(100) NOT NULL DEFAULT 'US Visa',
      status VARCHAR(50) NOT NULL DEFAULT 'Active',
      employment_status VARCHAR(50) NOT NULL DEFAULT 'Active',
      task_order VARCHAR(255) NULL,
      assigned_sub_account VARCHAR(255) NULL,
      herodash VARCHAR(255) NULL,
      msd VARCHAR(255) NULL,
      include_dashboard TINYINT(1) NOT NULL DEFAULT 1,
      include_reports TINYINT(1) NOT NULL DEFAULT 1,
      kpi_tracking_enabled TINYINT(1) NOT NULL DEFAULT 1,
      task_order_assigned_at DATETIME NULL,
      sub_account_assigned_at DATETIME NULL,
      last_synced_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_us_visa_kpi_employee_uid (employee_uid),
      KEY idx_us_visa_kpi_employee_id (employee_id),
      KEY idx_us_visa_kpi_employee_name (employee_name),
      KEY idx_us_visa_kpi_employee_status (status, employment_status),
      KEY idx_us_visa_kpi_employee_account (account_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log("Created/verified: us_visa_kpi_employees");

  await db.query(`
    CREATE TABLE IF NOT EXISTS us_visa_kpi_employee_aliases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      employee_uid VARCHAR(100) NOT NULL,
      source_system VARCHAR(80) NOT NULL DEFAULT 'manual',
      source_agent_name VARCHAR(255) NOT NULL,
      source_agent_key VARCHAR(255) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_us_visa_kpi_alias_key (source_agent_key),
      KEY idx_us_visa_kpi_alias_employee_uid (employee_uid),
      KEY idx_us_visa_kpi_alias_source_system (source_system),
      CONSTRAINT fk_us_visa_kpi_alias_employee_uid
        FOREIGN KEY (employee_uid)
        REFERENCES us_visa_kpi_employees(employee_uid)
        ON DELETE CASCADE
        ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  console.log("Created/verified: us_visa_kpi_employee_aliases");
  console.log("US VISA KPI EMPLOYEE SETTINGS MIGRATION COMPLETED");
}

migrateUsVisaKpiEmployees()
  .catch((error) => {
    console.error("US VISA KPI EMPLOYEE SETTINGS MIGRATION FAILED");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
