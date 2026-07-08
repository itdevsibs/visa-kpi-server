import axios from "axios";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const DB3_API_BASE_URL = (
  process.env.DB3_API_BASE_URL || "https://krns.mysibs.info"
).trim();

const DB3_API_DATAS_PATH = (
  process.env.DB3_API_DATAS_PATH || "/service/datas"
).trim();

const DB3_API_KEY = (process.env.DB3_API_KEY || "").trim();

const DB3_API_AUTH_MODE = (process.env.DB3_API_AUTH_MODE || "bearer").trim();

const DB3_API_NO_CACHE = String(process.env.DB3_API_NO_CACHE || "true") === "true";

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeDb3ApiError(error, fallbackMessage = "DB3 Kronos API request failed.") {
  const status = error?.response?.status || 500;

  const responseMessage =
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.response?.data?.statusText ||
    error?.message ||
    fallbackMessage;

  const normalizedError = new Error(responseMessage);

  normalizedError.status = status;
  normalizedError.responseData = error?.response?.data || null;
  normalizedError.originalError = error;

  return normalizedError;
}

function buildDatasUrl() {
  const baseUrl = DB3_API_BASE_URL.replace(/\/+$/, "");

  if (baseUrl.endsWith("/service/datas")) {
    return baseUrl;
  }

  const path = DB3_API_DATAS_PATH.startsWith("/")
    ? DB3_API_DATAS_PATH
    : `/${DB3_API_DATAS_PATH}`;

  return `${baseUrl}${path}`;
}

function buildDb3Headers() {
  if (!DB3_API_KEY) {
    throw new Error("DB3_API_KEY is missing in .env.");
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (DB3_API_NO_CACHE) {
    headers["Cache-Control"] = "no-cache";
    headers.Pragma = "no-cache";
    headers.Expires = "0";
  }

  if (DB3_API_AUTH_MODE === "bearer") {
    headers.Authorization = `Bearer ${DB3_API_KEY}`;
  } else if (DB3_API_AUTH_MODE === "authorization") {
    headers.Authorization = DB3_API_KEY;
  } else if (DB3_API_AUTH_MODE === "x-api-key") {
    headers["x-api-key"] = DB3_API_KEY;
  } else if (DB3_API_AUTH_MODE === "api-key-header") {
    headers["api-key"] = DB3_API_KEY;
  } else if (DB3_API_AUTH_MODE === "apikey-header") {
    headers.apikey = DB3_API_KEY;
  } else {
    headers.Authorization = `Bearer ${DB3_API_KEY}`;
  }

  return headers;
}

function toPositiveInteger(value, fallback) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallback;
  }

  return Math.floor(numberValue);
}

function normalizeRow(row, index) {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    return {
      _rowNumber: index + 1,
      ...row,
    };
  }

  if (Array.isArray(row)) {
    return row.reduce(
      (acc, value, itemIndex) => {
        acc[`column_${itemIndex + 1}`] = value;
        return acc;
      },
      {
        _rowNumber: index + 1,
      }
    );
  }

  return {
    _rowNumber: index + 1,
    value: row,
  };
}

function findFirstArray(value, path = "root", depth = 0) {
  if (!value || depth > 8) {
    return {
      rows: [],
      path: "",
    };
  }

  if (Array.isArray(value)) {
    return {
      rows: value.map(normalizeRow),
      path,
    };
  }

  if (typeof value !== "object") {
    return {
      rows: [],
      path: "",
    };
  }

  const priorityKeys = [
    "records",
    "data",
    "datas",
    "record",
    "results",
    "result",
    "items",
    "rows",
    "list",
    "employees",
    "employee",
    "users",
    "user",
    "payload",
  ];

  for (const key of priorityKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findFirstArray(value[key], `${path}.${key}`, depth + 1);

      if (found.rows.length > 0 || Array.isArray(value[key])) {
        return found;
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (priorityKeys.includes(key)) continue;

    const found = findFirstArray(value[key], `${path}.${key}`, depth + 1);

    if (found.rows.length > 0) {
      return found;
    }
  }

  return {
    rows: [],
    path: "",
  };
}

function removeLocalOnlyQueryParams(query = {}) {
  const cleanQuery = { ...query };

  delete cleanQuery.page;
  delete cleanQuery.limit;
  delete cleanQuery.search;

  return cleanQuery;
}

function searchRows(rows = [], search = "") {
  const keyword = cleanString(search).toLowerCase();

  if (!keyword) return rows;

  return rows.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(keyword)
  );
}

function paginateRows(rows = [], query = {}) {
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(query.limit, DEFAULT_LIMIT);
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  const total = rows.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const currentPage = Math.min(page, totalPages);

  const offset = (currentPage - 1) * limit;
  const endIndex = offset + limit;

  return {
    data: rows.slice(offset, endIndex),
    pagination: {
      currentPage,
      totalPages,
      total,
      limit,
    },
  };
}

function buildFreshQuery(query = {}) {
  const upstreamQuery = removeLocalOnlyQueryParams(query);

  if (DB3_API_NO_CACHE) {
    upstreamQuery._fresh = "1";
    upstreamQuery._ts = Date.now();
  }

  return upstreamQuery;
}

export async function getDb3KronosDatas(query = {}) {
  try {
    const datasUrl = buildDatasUrl();
    const upstreamQuery = buildFreshQuery(query);

    console.log("[DB3 KRONOS API] Fetching latest production datas:", {
      url: datasUrl,
      page: query.page || 1,
      limit: query.limit || DEFAULT_LIMIT,
      noCache: DB3_API_NO_CACHE,
    });

    const response = await axios.get(datasUrl, {
      headers: buildDb3Headers(),
      params: upstreamQuery,
      timeout: 30000,
    });

    const rawData = response.data;
    const found = findFirstArray(rawData);
    const filteredRows = searchRows(found.rows, query.search);
    const paginated = paginateRows(filteredRows, query);

    return {
      success: true,
      data: paginated.data,
      recordsPath: found.path,
      raw: rawData,
      pagination: paginated.pagination,
    };
  } catch (error) {
    const normalizedError = normalizeDb3ApiError(
      error,
      "Failed to fetch DB3 Kronos datas."
    );

    console.error("[DB3 KRONOS API] getDb3KronosDatas error:", {
      message: normalizedError.message,
      status: normalizedError.status,
      responseData: normalizedError.responseData,
    });

    throw normalizedError;
  }
}

export async function getDb3KronosDataById(id, query = {}) {
  try {
    const datasUrl = buildDatasUrl();
    const upstreamQuery = buildFreshQuery(query);

    console.log("[DB3 KRONOS API] Fetching data by ID:", {
      url: datasUrl,
      id,
      noCache: DB3_API_NO_CACHE,
    });

    const response = await axios.get(datasUrl, {
      headers: buildDb3Headers(),
      params: upstreamQuery,
      timeout: 30000,
    });

    const rawData = response.data;
    const found = findFirstArray(rawData);

    const targetId = cleanString(id);

    const matchedRecord = found.rows.find((row) => {
      const possibleIds = [
        row.sibsId,
        row.sibs_id,
        row.employeeId,
        row.employee_id,
        row.empId,
        row.emp_id,
        row.employeeCode,
        row.employee_code,
        row.empCode,
        row.emp_code,
        row.gy_employee_code,
        row.gy_user_code,
        row.userid,
        row.user_id,
        row.id,
        row._rowNumber,
      ]
        .map((value) => cleanString(value))
        .filter(Boolean);

      return possibleIds.includes(targetId);
    });

    return matchedRecord || null;
  } catch (error) {
    const normalizedError = normalizeDb3ApiError(
      error,
      "Failed to fetch DB3 Kronos data by ID."
    );

    console.error("[DB3 KRONOS API] getDb3KronosDataById error:", {
      id,
      message: normalizedError.message,
      status: normalizedError.status,
      responseData: normalizedError.responseData,
    });

    throw normalizedError;
  }
}

export async function postDb3KronosDatas(payload = {}, query = {}) {
  try {
    const datasUrl = buildDatasUrl();
    const upstreamQuery = buildFreshQuery(query);

    console.log("[DB3 KRONOS API] Posting datas:", {
      url: datasUrl,
      noCache: DB3_API_NO_CACHE,
    });

    const response = await axios.post(datasUrl, payload, {
      headers: buildDb3Headers(),
      params: upstreamQuery,
      timeout: 30000,
    });

    const rawData = response.data;
    const found = findFirstArray(rawData);
    const filteredRows = searchRows(found.rows, query.search);
    const paginated = paginateRows(filteredRows, query);

    return {
      success: true,
      data: paginated.data,
      recordsPath: found.path,
      raw: rawData,
      pagination: paginated.pagination,
    };
  } catch (error) {
    const normalizedError = normalizeDb3ApiError(
      error,
      "Failed to post DB3 Kronos datas."
    );

    console.error("[DB3 KRONOS API] postDb3KronosDatas error:", {
      message: normalizedError.message,
      status: normalizedError.status,
      responseData: normalizedError.responseData,
    });

    throw normalizedError;
  }
}