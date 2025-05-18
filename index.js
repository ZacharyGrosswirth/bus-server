const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");

const port = process.env.PORT || 4000;

const allowedOrigins = [
  "http://localhost:3000",
  "https://bus-server-zei8.onrender.com",
];

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("CORS not allowed"));
    },
    methods: ["GET", "POST"],
  },
});

app.get("/", (req, res) => {
  res.send(`Ride the Bus server is running on port ${port}`);
});

io.on("connection", (socket) => {
  console.log("a user connected", socket.id);
  socket.on("disconnect", () => {
    console.log("a user disconnected");
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
