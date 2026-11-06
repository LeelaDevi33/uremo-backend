const http = require("http");
require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { initSocket } = require("./socket");

connectDB();

const PORT = process.env.PORT || 5000;

// Create HTTP server and attach Socket.io
const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  console.log(`UREMO backend running on port ${PORT}`);
});
