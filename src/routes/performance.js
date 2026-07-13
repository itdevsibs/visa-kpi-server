import express from "express";
import db from "../config/db.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

const TABLES = Object.freeze({
  employees: "us_visa_kpi_employees",
  aliases: "us_visa_kpi_employee_aliases",
  hourlySummary: "us_visa_kpi_hourly_summary",
});

const ACTIVE_EMPLOYEE_SQL = `
  LOWER(TRIM(e.account_name)) = 'us visa'
  AND LOWER(TRIM(e.status)) = 'active'
  AND LOWER(TRIM(e.employment_status)) = 'active'
`;

function normalizeDate(value) {
  const cleanValue = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(cleanValue) ? cleanValue : "";
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsedValue));
}

function normalizeInterval(value) {
  return String(value || "Daily").trim().toLowerCase() === "hourly"
    ? "Hourly"
    : "Daily";
}

function normalizeEmployeeUids(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 500);
}

function subtractCalendarDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

async function runQuery(sql, params = []) {
  const result = await db.query(sql, params);

  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0];
  }

  return Array.isArray(result) ? result : [];
}

function buildMatchedSummaryCte({
  dateMode = "all",
  productionDate = "",
  dateFrom = "",
  dateTo = "",
  fromHour = 0,
  toHourExclusive = 24,
} = {}) {
  const whereParts = [];
  const params = [];

  if (dateMode === "single") {
    whereParts.push("hs.production_date = ?");
    params.push(productionDate);
  } else if (dateMode === "range") {
    whereParts.push("hs.production_date BETWEEN ? AND ?");
    params.push(dateFrom, dateTo);
  }

  if (dateMode !== "all") {
    whereParts.push("hs.interval_hour >= ?");
    whereParts.push("hs.interval_hour < ?");
    params.push(fromHour, toHourExclusive);
  }

  const whereSql = whereParts.length
    ? `WHERE ${whereParts.join("\n      AND ")}`
    : "";

  return {
    params,
    sql: `
      WITH raw_filtered_summary AS (
        SELECT
          hs.*,
          ROW_NUMBER() OVER (
            PARTITION BY
              hs.production_date,
              hs.interval_hour,
              COALESCE(
                NULLIF(TRIM(hs.agent_key), ''),
                REGEXP_REPLACE(LOWER(TRIM(hs.agent_name)), '[^a-z0-9]+', '')
              )
            ORDER BY hs.id DESC
          ) AS source_row_rank
        FROM ${TABLES.hourlySummary} hs
        ${whereSql}
      ),
      filtered_summary AS (
        SELECT *
        FROM raw_filtered_summary
        WHERE source_row_rank = 1
      ),
      candidate_matches AS (
        SELECT DISTINCT
          fs.id AS summary_id,
          a.employee_uid,
          1 AS match_priority
        FROM filtered_summary fs
        INNER JOIN ${TABLES.aliases} a
          ON a.is_active = 1
         AND NULLIF(TRIM(fs.agent_key), '') IS NOT NULL
         AND a.source_agent_key = fs.agent_key
        INNER JOIN ${TABLES.employees} e
          ON e.employee_uid = a.employee_uid
         AND ${ACTIVE_EMPLOYEE_SQL}

        UNION ALL

        SELECT DISTINCT
          fs.id AS summary_id,
          a.employee_uid,
          2 AS match_priority
        FROM filtered_summary fs
        INNER JOIN ${TABLES.aliases} a
          ON a.is_active = 1
         AND REGEXP_REPLACE(
               LOWER(TRIM(a.source_agent_name)),
               '[^a-z0-9]+',
               ''
             ) = REGEXP_REPLACE(
               LOWER(TRIM(fs.agent_name)),
               '[^a-z0-9]+',
               ''
             )
        INNER JOIN ${TABLES.employees} e
          ON e.employee_uid = a.employee_uid
         AND ${ACTIVE_EMPLOYEE_SQL}
        WHERE NULLIF(TRIM(fs.agent_name), '') IS NOT NULL

        UNION ALL

        SELECT DISTINCT
          fs.id AS summary_id,
          e.employee_uid,
          3 AS match_priority
        FROM filtered_summary fs
        INNER JOIN ${TABLES.employees} e
          ON REGEXP_REPLACE(
               LOWER(TRIM(e.employee_name)),
               '[^a-z0-9]+',
               ''
             ) = REGEXP_REPLACE(
               LOWER(TRIM(fs.agent_name)),
               '[^a-z0-9]+',
               ''
             )
         AND ${ACTIVE_EMPLOYEE_SQL}
        WHERE NULLIF(TRIM(fs.agent_name), '') IS NOT NULL
      ),
      minimum_priority AS (
        SELECT
          summary_id,
          MIN(match_priority) AS match_priority
        FROM candidate_matches
        GROUP BY summary_id
      ),
      best_candidates AS (
        SELECT DISTINCT
          candidate.summary_id,
          candidate.employee_uid
        FROM candidate_matches candidate
        INNER JOIN minimum_priority priority
          ON priority.summary_id = candidate.summary_id
         AND priority.match_priority = candidate.match_priority
      ),
      unique_matches AS (
        SELECT
          summary_id,
          MAX(employee_uid) AS employee_uid
        FROM best_candidates
        GROUP BY summary_id
        HAVING COUNT(DISTINCT employee_uid) = 1
      ),
      matched_summary AS (
        SELECT
          fs.*,
          unique_matches.employee_uid
        FROM filtered_summary fs
        INNER JOIN unique_matches
          ON unique_matches.summary_id = fs.id
      )
    `,
  };
}

function getEmployeeProjection() {
  return `
    e.employee_uid AS employeeUid,
    COALESCE(NULLIF(e.employee_id, ''), NULLIF(e.employee_number, ''), e.employee_uid) AS employeeId,
    e.employee_number AS employeeNumber,
    e.employee_name AS employeeName,
    e.email,
    e.position,
    e.department,
    e.team,
    e.supervisor,
    e.account_name AS accountName,
    e.status,
    e.employment_status AS employmentStatus,
    e.task_order AS taskOrder,
    e.assigned_sub_account AS assignedSubAccount,
    e.herodash,
    e.msd
  `;
}

router.get("/bootstrap", authMiddleware, async (req, res) => {
  try {
    const matchedCte = buildMatchedSummaryCte({ dateMode: "all" });

    const employees = await runQuery(
      `
        ${matchedCte.sql}
        SELECT DISTINCT
          ${getEmployeeProjection()}
        FROM matched_summary matched
        INNER JOIN ${TABLES.employees} e
          ON e.employee_uid = matched.employee_uid
        WHERE ${ACTIVE_EMPLOYEE_SQL}
        ORDER BY e.employee_name ASC
      `,
      matchedCte.params,
    );

    const latestDateRows = await runQuery(
      `
        ${matchedCte.sql}
        SELECT DATE_FORMAT(MAX(production_date), '%Y-%m-%d') AS latestProductionDate
        FROM matched_summary
      `,
      matchedCte.params,
    );

    return res.status(200).json({
      success: true,
      data: {
        employees,
        latestProductionDate: latestDateRows[0]?.latestProductionDate || null,
      },
      message: "Matched US Visa performance employees loaded successfully.",
    });
  } catch (error) {
    console.error("GET /api/performance/bootstrap error:", error);

    return res.status(500).json({
      success: false,
      data: {
        employees: [],
        latestProductionDate: null,
      },
      message: error.sqlMessage || error.message || "Unable to load performance employees.",
    });
  }
});

router.get("/records", authMiddleware, async (req, res) => {
  try {
    const productionDate = normalizeDate(req.query.date);

    if (!productionDate) {
      return res.status(400).json({
        success: false,
        data: [],
        message: "A valid date in YYYY-MM-DD format is required.",
      });
    }

    const fromHour = normalizeInteger(req.query.fromHour, 0, 0, 23);
    const toHourExclusive = normalizeInteger(
      req.query.toHourExclusive,
      24,
      1,
      24,
    );
    const interval = normalizeInterval(req.query.interval);
    const employeeUids = normalizeEmployeeUids(req.query.employeeUids);

    if (toHourExclusive <= fromHour) {
      return res.status(400).json({
        success: false,
        data: [],
        message: "End time must be later than start time.",
      });
    }

    const matchedCte = buildMatchedSummaryCte({
      dateMode: "single",
      productionDate,
      fromHour,
      toHourExclusive,
    });

    const employeeFilterSql = employeeUids.length
      ? `AND e.employee_uid IN (${employeeUids.map(() => "?").join(", ")})`
      : "";

    const params = [...matchedCte.params, ...employeeUids];

    const recordsSql =
      interval === "Hourly"
        ? `
          ${matchedCte.sql}
          SELECT
            e.employee_uid AS employeeId,
            e.employee_name AS employeeName,
            e.email,
            e.position,
            e.team,
            DATE_FORMAT(matched.production_date, '%Y-%m-%d') AS productionDate,
            matched.interval_hour AS hour,
            SUM(matched.expected_seconds) AS expectedSeconds,
            SUM(matched.actual_logged_seconds) AS loggedSeconds,
            SUM(matched.handled_calls) AS handledCalls,
            CASE
              WHEN SUM(matched.handled_calls) > 0
              THEN ROUND(
                SUM(matched.avg_talk_seconds * matched.handled_calls) /
                SUM(matched.handled_calls)
              )
              ELSE 0
            END AS avgTalkTime,
            CASE
              WHEN SUM(matched.handled_calls) > 0
              THEN ROUND(
                SUM(matched.avg_hold_seconds * matched.handled_calls) /
                SUM(matched.handled_calls)
              )
              ELSE 0
            END AS avgHoldTime,
            SUM(matched.available_seconds) AS availableSeconds,
            CASE
              WHEN SUM(matched.actual_logged_seconds) > 0
              THEN ROUND(
                SUM(matched.phone_occupancy_pct * matched.actual_logged_seconds) /
                SUM(matched.actual_logged_seconds),
                2
              )
              ELSE 0
            END AS phoneOccupancy,
            SUM(matched.email_capacity) AS availableEmailCapacity,
            SUM(matched.target_emails) AS targetEmails,
            SUM(matched.actual_emails) AS actualEmails,
            CASE
              WHEN SUM(matched.target_emails) > 0
              THEN ROUND(SUM(matched.actual_emails) / SUM(matched.target_emails) * 100, 2)
              ELSE 0
            END AS emailUtilization,
            CASE
              WHEN SUM(matched.expected_seconds) > 0
              THEN ROUND(
                SUM(matched.actual_efficiency_pct * matched.expected_seconds) /
                SUM(matched.expected_seconds),
                2
              )
              ELSE ROUND(AVG(matched.actual_efficiency_pct), 2)
            END AS efficiency
          FROM matched_summary matched
          INNER JOIN ${TABLES.employees} e
            ON e.employee_uid = matched.employee_uid
          WHERE ${ACTIVE_EMPLOYEE_SQL}
            ${employeeFilterSql}
          GROUP BY
            e.employee_uid,
            e.employee_name,
            e.email,
            e.position,
            e.team,
            matched.production_date,
            matched.interval_hour
          ORDER BY e.employee_name ASC, matched.interval_hour ASC
        `
        : `
          ${matchedCte.sql}
          SELECT
            e.employee_uid AS employeeId,
            e.employee_name AS employeeName,
            e.email,
            e.position,
            e.team,
            DATE_FORMAT(matched.production_date, '%Y-%m-%d') AS productionDate,
            SUM(matched.expected_seconds) AS expectedSeconds,
            SUM(matched.actual_logged_seconds) AS loggedSeconds,
            SUM(matched.handled_calls) AS handledCalls,
            CASE
              WHEN SUM(matched.handled_calls) > 0
              THEN ROUND(
                SUM(matched.avg_talk_seconds * matched.handled_calls) /
                SUM(matched.handled_calls)
              )
              ELSE 0
            END AS avgTalkTime,
            CASE
              WHEN SUM(matched.handled_calls) > 0
              THEN ROUND(
                SUM(matched.avg_hold_seconds * matched.handled_calls) /
                SUM(matched.handled_calls)
              )
              ELSE 0
            END AS avgHoldTime,
            SUM(matched.available_seconds) AS availableSeconds,
            CASE
              WHEN SUM(matched.actual_logged_seconds) > 0
              THEN ROUND(
                SUM(matched.phone_occupancy_pct * matched.actual_logged_seconds) /
                SUM(matched.actual_logged_seconds),
                2
              )
              ELSE 0
            END AS phoneOccupancy,
            SUM(matched.email_capacity) AS availableEmailCapacity,
            SUM(matched.target_emails) AS targetEmails,
            SUM(matched.actual_emails) AS actualEmails,
            CASE
              WHEN SUM(matched.target_emails) > 0
              THEN ROUND(SUM(matched.actual_emails) / SUM(matched.target_emails) * 100, 2)
              ELSE 0
            END AS emailUtilization,
            CASE
              WHEN SUM(matched.expected_seconds) > 0
              THEN ROUND(
                SUM(matched.actual_efficiency_pct * matched.expected_seconds) /
                SUM(matched.expected_seconds),
                2
              )
              ELSE ROUND(AVG(matched.actual_efficiency_pct), 2)
            END AS efficiency
          FROM matched_summary matched
          INNER JOIN ${TABLES.employees} e
            ON e.employee_uid = matched.employee_uid
          WHERE ${ACTIVE_EMPLOYEE_SQL}
            ${employeeFilterSql}
          GROUP BY
            e.employee_uid,
            e.employee_name,
            e.email,
            e.position,
            e.team,
            matched.production_date
          ORDER BY e.employee_name ASC
        `;

    const records = await runQuery(recordsSql, params);

    return res.status(200).json({
      success: true,
      data: records,
      filters: {
        productionDate,
        fromHour,
        toHourExclusive,
        interval,
        employeeUids,
      },
      message: "Matched performance records loaded successfully.",
    });
  } catch (error) {
    console.error("GET /api/performance/records error:", error);

    return res.status(500).json({
      success: false,
      data: [],
      message: error.sqlMessage || error.message || "Unable to load performance records.",
    });
  }
});

router.get("/history", authMiddleware, async (req, res) => {
  try {
    const employeeUid = String(req.query.employeeUid || "").trim();
    const dateTo = normalizeDate(req.query.dateTo);
    const days = normalizeInteger(req.query.days, 5, 1, 31);
    const fromHour = normalizeInteger(req.query.fromHour, 0, 0, 23);
    const toHourExclusive = normalizeInteger(
      req.query.toHourExclusive,
      24,
      1,
      24,
    );

    if (!employeeUid || !dateTo) {
      return res.status(400).json({
        success: false,
        data: [],
        message: "employeeUid and dateTo are required.",
      });
    }

    const dateFrom = subtractCalendarDays(dateTo, days - 1);
    const matchedCte = buildMatchedSummaryCte({
      dateMode: "range",
      dateFrom,
      dateTo,
      fromHour,
      toHourExclusive,
    });

    const history = await runQuery(
      `
        ${matchedCte.sql}
        SELECT
          DATE_FORMAT(matched.production_date, '%Y-%m-%d') AS date,
          SUM(matched.handled_calls) AS calls,
          SUM(matched.actual_emails) AS emails,
          CASE
            WHEN SUM(matched.actual_logged_seconds) > 0
            THEN ROUND(
              SUM(matched.phone_occupancy_pct * matched.actual_logged_seconds) /
              SUM(matched.actual_logged_seconds),
              2
            )
            ELSE 0
          END AS occupancy,
          CASE
            WHEN SUM(matched.expected_seconds) > 0
            THEN ROUND(
              SUM(matched.actual_efficiency_pct * matched.expected_seconds) /
              SUM(matched.expected_seconds),
              2
            )
            ELSE ROUND(AVG(matched.actual_efficiency_pct), 2)
          END AS efficiency
        FROM matched_summary matched
        INNER JOIN ${TABLES.employees} e
          ON e.employee_uid = matched.employee_uid
        WHERE ${ACTIVE_EMPLOYEE_SQL}
          AND e.employee_uid = ?
        GROUP BY matched.production_date
        ORDER BY matched.production_date DESC
      `,
      [...matchedCte.params, employeeUid],
    );

    return res.status(200).json({
      success: true,
      data: history,
      message: "Matched employee performance history loaded successfully.",
    });
  } catch (error) {
    console.error("GET /api/performance/history error:", error);

    return res.status(500).json({
      success: false,
      data: [],
      message: error.sqlMessage || error.message || "Unable to load performance history.",
    });
  }
});

export default router;
