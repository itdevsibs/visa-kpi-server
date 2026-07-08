import axios from "axios";

const DEFAULT_LIMIT = 25;

const DB3_API_BASE_URL = (
  process.env.DB3_API_BASE_URL || "https://krns.mysibs.info"
).trim();

const DB3_API_KEY = (process.env.DB3_API_KEY || "").trim();

const DB3_API_AUTH_MODE = (process.env.DB3_API_AUTH_MODE || "bearer").trim();

const DB3_API_EMPLOYEES_PATH = (
  process.env.DB3_API_EMPLOYEES_PATH || "/api/employees"
).trim();

function buildUrl(path) {
  const baseUrl = DB3_API_BASE_URL.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  return `${baseUrl}${cleanPath}`;
}

function buildDb3Headers() {
  if (!DB3_API_KEY) {
    throw new Error("DB3_API_KEY is missing in .env.");
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "0",
  };

  if (DB3_API_AUTH_MODE === "bearer") {
    headers.Authorization = `Bearer ${DB3_API_KEY}`;
  } else if (DB3_API_AUTH_MODE === "authorization") {
    headers.Authorization = DB3_API_KEY;
  } else if (DB3_API_AUTH_MODE === "x-api-key") {
    headers["x-api-key"] = DB3_API_KEY;
  } else {
    headers.Authorization = `Bearer ${DB3_API_KEY}`;
  }

  return headers;
}

export async function getDb3KronosEmployees({
  page = 1,
  search = "",
  department = "All",
  account = "All",
  includeDepartments = 0,
  includeAccounts = 0,
  limit = DEFAULT_LIMIT,
} = {}) {
  const url = buildUrl(DB3_API_EMPLOYEES_PATH);

  const response = await axios.get(url, {
    headers: buildDb3Headers(),
    params: {
      page,
      search,
      department,
      account,
      includeDepartments,
      includeAccounts,
      limit,
      _fresh: 1,
      _ts: Date.now(),
    },
    timeout: 30000,
  });

  return response.data;
}

export async function getDb3KronosEmployeeById(sibsId) {
  const url = buildUrl(
    `${DB3_API_EMPLOYEES_PATH}/${encodeURIComponent(String(sibsId || "").trim())}`,
  );

  const response = await axios.get(url, {
    headers: buildDb3Headers(),
    params: {
      _fresh: 1,
      _ts: Date.now(),
    },
    timeout: 30000,
  });

  return response.data;
}