const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error("Missing MONGO_URI environment variable - aborting");
      process.exit(1);
    }
    if (process.env.UREMO_ENVIRONMENT === "staging") {
      const { dbName } = new mongoose.mongo.MongoClient(process.env.MONGO_URI).options;
      if (dbName !== "uremo_staging") {
        throw new Error("The staging service requires the uremo_staging database.");
      }
    }
    // Mongoose v6+ enables the new URL parser and unified topology by default.
    // Passing the old options causes an error on some environments (e.g. Render):
    // "options usenewurlparser, useunifiedtopology are not supported".
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed", { name: err.name, code: err.code });
    process.exit(1);
  }
};

module.exports = connectDB;
