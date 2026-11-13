const http = require("http");
require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { initSocket } = require("./socket");

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  // Receiving payments requires the unique settlement, checkout and inventory indexes.
  // Mongoose init creates missing indexes but never drops records or existing indexes.
  await Promise.all([
    require("./models/WalletTransaction").init(),
    require("./models/OpportunityGrant").init(),
    require("./models/Opportunity").init(),
  ]);
  const server = http.createServer(app);
  initSocket(server);
  server.listen(PORT, () => console.log(`UREMO backend running on port ${PORT}`));
}

start().catch(err => {
  // Duplicate-key messages can contain a customer's transfer reference.
  console.error("Marketplace indexes could not be initialized. Review duplicate records or conflicting indexes before restarting.", { code: err.code, name: err.name });
  process.exit(1);
});
