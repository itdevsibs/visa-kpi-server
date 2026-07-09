import db from "../config/db.js";

async function runMigration() {
  console.log("========================================");
  console.log("US VISA KPI TABLE MIGRATION STARTED");
  console.log("========================================");

  try {
    // ===============================
    // 1. Upload / Import Batch Tracker
    // ===============================
    await db.query(`
      CREATE TABLE IF NOT EXISTS us_visa_kpi_upload_batches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        batch_code VARCHAR(80) NOT NULL,
        source_filename VARCHAR(255) DEFAULT NULL,
        production_date DATE DEFAULT NULL,
        uploaded_by BIGINT UNSIGNED DEFAULT NULL,

        status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',

        agent_activity_rows INT UNSIGNED NOT NULL DEFAULT 0,
        calls_answered_rows INT UNSIGNED NOT NULL DEFAULT 0,
        email_case_rows INT UNSIGNED NOT NULL DEFAULT 0,
        summary_rows INT UNSIGNED NOT NULL DEFAULT 0,

        error_message TEXT DEFAULT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        completed_at TIMESTAMP NULL DEFAULT NULL,

        PRIMARY KEY (id),
        UNIQUE KEY uq_us_visa_kpi_batch_code (batch_code),
        KEY idx_us_visa_kpi_batches_production_date (production_date),
        KEY idx_us_visa_kpi_batches_status (status),
        KEY idx_us_visa_kpi_batches_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Created/verified: us_visa_kpi_upload_batches");

    // ===============================
    // 2. Agent Activity Raw Dump
    // Source: HD_AgentStatistics_AgentActivity
    // ===============================
    await db.query(`
      CREATE TABLE IF NOT EXISTS us_visa_agent_activity_raw (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        batch_id BIGINT UNSIGNED NOT NULL,

        timestamp_raw VARCHAR(100) DEFAULT NULL,
        agent_raw VARCHAR(255) DEFAULT NULL,
        duration_seconds INT DEFAULT 0,
        activity_date DATE DEFAULT NULL,
        agent_name VARCHAR(255) DEFAULT NULL,
        start_time_raw VARCHAR(100) DEFAULT NULL,
        end_time_raw VARCHAR(100) DEFAULT NULL,
        duration_text VARCHAR(100) DEFAULT NULL,
        status VARCHAR(100) DEFAULT NULL,

        row_json JSON DEFAULT NULL,
        row_hash CHAR(64) NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_us_visa_agent_activity_batch_hash (batch_id, row_hash),

        KEY idx_us_visa_agent_activity_batch_id (batch_id),
        KEY idx_us_visa_agent_activity_date (activity_date),
        KEY idx_us_visa_agent_activity_agent_name (agent_name),
        KEY idx_us_visa_agent_activity_status (status),

        CONSTRAINT fk_us_visa_agent_activity_batch
          FOREIGN KEY (batch_id)
          REFERENCES us_visa_kpi_upload_batches(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Created/verified: us_visa_agent_activity_raw");

    // ===============================
    // 3. Calls Answered Raw Dump
    // Source: HD_CallReport_CallsAnswered
    // ===============================
    await db.query(`
      CREATE TABLE IF NOT EXISTS us_visa_calls_answered_raw (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        batch_id BIGINT UNSIGNED NOT NULL,

        timestamp_raw VARCHAR(100) DEFAULT NULL,
        agent_raw VARCHAR(255) DEFAULT NULL,
        talk_seconds INT DEFAULT 0,
        activity_date DATE DEFAULT NULL,

        call_id VARCHAR(120) DEFAULT NULL,
        direction VARCHAR(80) DEFAULT NULL,

        arrival_time_raw VARCHAR(100) DEFAULT NULL,
        arrival_queue_time_raw VARCHAR(100) DEFAULT NULL,
        answer_time_raw VARCHAR(100) DEFAULT NULL,
        end_time_raw VARCHAR(100) DEFAULT NULL,

        agent_name VARCHAR(255) DEFAULT NULL,
        skill VARCHAR(255) DEFAULT NULL,
        disconnect_indicator VARCHAR(120) DEFAULT NULL,

        duration_seconds INT DEFAULT 0,
        total_hold_seconds INT DEFAULT 0,
        total_hold_count INT DEFAULT 0,

        row_json JSON DEFAULT NULL,
        row_hash CHAR(64) NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_us_visa_calls_answered_batch_hash (batch_id, row_hash),

        KEY idx_us_visa_calls_answered_batch_id (batch_id),
        KEY idx_us_visa_calls_answered_date (activity_date),
        KEY idx_us_visa_calls_answered_agent_name (agent_name),
        KEY idx_us_visa_calls_answered_call_id (call_id),
        KEY idx_us_visa_calls_answered_direction (direction),

        CONSTRAINT fk_us_visa_calls_answered_batch
          FOREIGN KEY (batch_id)
          REFERENCES us_visa_kpi_upload_batches(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Created/verified: us_visa_calls_answered_raw");

    // ===============================
    // 4. Email Cases Raw Dump
    // Source: MSD(WFM Handled Emails)
    // ===============================
    await db.query(`
      CREATE TABLE IF NOT EXISTS us_visa_email_cases_raw (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        batch_id BIGINT UNSIGNED NOT NULL,

        timestamp_raw VARCHAR(100) DEFAULT NULL,
        agent_raw VARCHAR(255) DEFAULT NULL,

        case_number VARCHAR(150) DEFAULT NULL,
        created_on_raw VARCHAR(100) DEFAULT NULL,
        modified_on_raw VARCHAR(100) DEFAULT NULL,
        resolution_date_raw VARCHAR(100) DEFAULT NULL,

        created_by VARCHAR(255) DEFAULT NULL,
        modified_by VARCHAR(255) DEFAULT NULL,

        case_status VARCHAR(150) DEFAULT NULL,
        status VARCHAR(150) DEFAULT NULL,
        case_country VARCHAR(150) DEFAULT NULL,
        owner VARCHAR(255) DEFAULT NULL,
        origin VARCHAR(150) DEFAULT NULL,
        applicant VARCHAR(255) DEFAULT NULL,

        description TEXT DEFAULT NULL,

        row_json JSON DEFAULT NULL,
        row_hash CHAR(64) NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_us_visa_email_cases_batch_hash (batch_id, row_hash),

        KEY idx_us_visa_email_cases_batch_id (batch_id),
        KEY idx_us_visa_email_cases_case_number (case_number),
        KEY idx_us_visa_email_cases_owner (owner),
        KEY idx_us_visa_email_cases_created_by (created_by),
        KEY idx_us_visa_email_cases_modified_by (modified_by),
        KEY idx_us_visa_email_cases_status (status),
        KEY idx_us_visa_email_cases_case_status (case_status),

        CONSTRAINT fk_us_visa_email_cases_batch
          FOREIGN KEY (batch_id)
          REFERENCES us_visa_kpi_upload_batches(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Created/verified: us_visa_email_cases_raw");

    // ===============================
    // 5. Final Hourly KPI Summary
    // This is the backend version of the 4th Excel image.
    // ===============================
    await db.query(`
      CREATE TABLE IF NOT EXISTS us_visa_kpi_hourly_summary (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        batch_id BIGINT UNSIGNED DEFAULT NULL,

        production_date DATE NOT NULL,

        agent_key VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255) NOT NULL,

        interval_hour TINYINT UNSIGNED NOT NULL,

        expected_seconds INT NOT NULL DEFAULT 3600,
        actual_logged_seconds INT NOT NULL DEFAULT 0,

        handled_calls INT NOT NULL DEFAULT 0,
        avg_talk_seconds INT NOT NULL DEFAULT 0,
        avg_hold_seconds INT NOT NULL DEFAULT 0,

        available_seconds INT NOT NULL DEFAULT 0,

        phone_occupancy_pct DECIMAL(8,2) NOT NULL DEFAULT 0.00,

        email_capacity INT NOT NULL DEFAULT 0,
        target_emails INT NOT NULL DEFAULT 0,
        actual_emails INT NOT NULL DEFAULT 0,
        email_utilization_pct DECIMAL(8,2) NOT NULL DEFAULT 0.00,

        actual_efficiency_pct DECIMAL(8,2) NOT NULL DEFAULT 0.00,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_us_visa_kpi_summary_date_agent_hour (
          production_date,
          agent_key,
          interval_hour
        ),

        KEY idx_us_visa_kpi_summary_batch_id (batch_id),
        KEY idx_us_visa_kpi_summary_date (production_date),
        KEY idx_us_visa_kpi_summary_agent_key (agent_key),
        KEY idx_us_visa_kpi_summary_agent_name (agent_name),
        KEY idx_us_visa_kpi_summary_interval_hour (interval_hour),

        CONSTRAINT fk_us_visa_kpi_summary_batch
          FOREIGN KEY (batch_id)
          REFERENCES us_visa_kpi_upload_batches(id)
          ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("Created/verified: us_visa_kpi_hourly_summary");

    console.log("========================================");
    console.log("US VISA KPI TABLE MIGRATION COMPLETED");
    console.log("========================================");

    process.exit(0);
  } catch (err) {
    console.error("========================================");
    console.error("US VISA KPI TABLE MIGRATION FAILED");
    console.error("========================================");
    console.error(err);

    process.exit(1);
  }
}

runMigration();