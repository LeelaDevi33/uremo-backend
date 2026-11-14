const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI environment variable");
  if (process.env.UREMO_ENVIRONMENT === "staging" && new mongoose.mongo.MongoClient(uri).options.dbName !== "uremo_staging") {
    throw new Error("The staging service requires the uremo_staging database");
  }
  await mongoose.connect(uri);
  console.log("MongoDB connected");
}

module.exports = connectDB;
