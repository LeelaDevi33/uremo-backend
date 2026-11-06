const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error("Missing MONGO_URI environment variable - aborting");
      process.exit(1);
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
