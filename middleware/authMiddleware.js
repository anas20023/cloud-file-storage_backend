const admin = require("firebase-admin");

const verifyIdToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1]; // Bearer token

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Error verifying token:", error);
    res.status(401).send({ message: "Invalid token" });
  }
};

module.exports = { verifyIdToken };
