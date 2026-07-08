// middleware/roleMiddleware.js

/**
 * Generic role middleware
 *
 * Usage:
 * router.get("/users", authMiddleware, allowRoles("admin", "hr"), controller);
 */

export const allowRoles = (...roles) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized.",
        });
      }

      if (!roles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to access this resource.",
        });
      }

      next();
    } catch (err) {
      console.error("Role Middleware Error:", err);

      return res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  };
};

/**
 * Any authenticated user
 */
export const authenticated = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized.",
    });
  }

  next();
};

/**
 * Employee only
 */
export const employeeOnly = allowRoles("employee");

/**
 * Team Leader only
 */
export const teamLeaderOnly = allowRoles("team_leader");

/**
 * Supervisor only
 */
export const supervisorOnly = allowRoles("supervisor");

/**
 * Manager only
 */
export const managerOnly = allowRoles("manager");

/**
 * HR only
 */
export const hrOnly = allowRoles("hr");

/**
 * Recruiter only
 */
export const recruiterOnly = allowRoles("recruiter");

/**
 * Admin only
 */
export const adminOnly = allowRoles("admin");

/**
 * Super Admin only
 */
export const superAdminOnly = allowRoles("super_admin");

/**
 * HR or Admin
 */
export const hrAdminOnly = allowRoles(
  "hr",
  "admin",
  "super_admin"
);

/**
 * Management Level
 */
export const managementOnly = allowRoles(
  "manager",
  "admin",
  "super_admin"
);

/**
 * HR Department
 */
export const hrDepartmentOnly = allowRoles(
  "recruiter",
  "hr",
  "admin",
  "super_admin"
);

/**
 * Everyone except employees
 */
export const staffOnly = allowRoles(
  "team_leader",
  "supervisor",
  "manager",
  "recruiter",
  "hr",
  "admin",
  "super_admin"
);

export default {
  authenticated,
  allowRoles,
  employeeOnly,
  teamLeaderOnly,
  supervisorOnly,
  managerOnly,
  recruiterOnly,
  hrOnly,
  adminOnly,
  superAdminOnly,
  hrAdminOnly,
  managementOnly,
  hrDepartmentOnly,
  staffOnly,
};