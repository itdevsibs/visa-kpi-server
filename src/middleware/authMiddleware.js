import jwt from "jsonwebtoken";

const authMiddleware = (req, res, next) => {
  try {
    let token = null;
    let secret = null;
    let tokenType = null;

    // ===========================
    // Check Cookies
    // ===========================
    if (req.cookies?.admin_token) {
      token = req.cookies.admin_token;
      secret = process.env.JWT_ADMIN_SECRET;
      tokenType = "admin";
    } else if (req.cookies?.token) {
      token = req.cookies.token;
      secret = process.env.JWT_SECRET;
      tokenType = "employee";
    }

    // ===========================
    // Check Authorization Header
    // ===========================
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
      secret = process.env.JWT_SECRET;
      tokenType = "bearer";
    }

    // ===========================
    // No Token
    // ===========================
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    // ===========================
    // Secret Missing
    // ===========================
    if (!secret) {
      console.error("JWT Secret is not configured.");

      return res.status(500).json({
        success: false,
        message: "Server configuration error.",
      });
    }

    // ===========================
    // Verify Token
    // ===========================
    const decoded = jwt.verify(token, secret);

    req.user = {
      ...decoded,
      tokenType,
    };

    return next();
  } catch (err) {
    console.error("Authentication Error:", err);

    switch (err.name) {
      case "TokenExpiredError":
        return res.status(401).json({
          success: false,
          message: "Session expired. Please log in again.",
        });

      case "JsonWebTokenError":
        return res.status(401).json({
          success: false,
          message: "Invalid authentication token.",
        });

      case "NotBeforeError":
        return res.status(401).json({
          success: false,
          message: "Token is not active yet.",
        });

      default:
        return res.status(500).json({
          success: false,
          message: "Internal server error.",
        });
    }
  }
};

export default authMiddleware;