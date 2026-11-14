const http = require("http");
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./config/db");

const PORT = process.env.PORT || 5000;

async function start() {
  if (!process.env.JWT_SECRET?.trim()) throw new Error("JWT_SECRET is required to serve authenticated requests.");
  try {
    await connectDB();
  } catch (cause) {
    throw new Error("MongoDB connection failed. Check the database configuration for this environment.", { cause });
  }
  // An actual read-only transaction checks topology, sessions and transaction support.
  try {
    await mongoose.connection.transaction(session => mongoose.connection.db.collection("users")
      .findOne({ _id: null }, { projection: { _id: 1 }, session }));
  } catch (cause) {
    throw new Error("MongoDB must support transactions for checkout and wallet settlement.", { cause });
  }
  const app = require("./app");
  try {
    await require("./services/marketplaceIndexes").initializeMarketplaceIndexes(mongoose.connection.db);
  } catch (cause) {
    throw new Error("Marketplace indexes could not be initialized. Review duplicate records or conflicting indexes before restarting.", { cause });
  }
  const server = http.createServer(app);
  require("./socket").initSocket(server);
  server.listen(PORT, () => console.log(`UREMO backend running on port ${server.address().port}`));
}

start().catch(err => {
  // Duplicate-key messages can contain a customer's transfer reference.
  console.error(err.message, { code: err.cause?.code, name: err.cause?.name || err.name });
  process.exit(1);
});
