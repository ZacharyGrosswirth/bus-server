const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { randomBytes } = require("crypto");

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
const roomsMeta = new Map();

function makeRoomId() {
  return randomBytes(3).toString("hex").toUpperCase();
}

app.get("/", (req, res) => {
  res.send(`Ride the Bus server is running on port ${port}`);
});

io.on("connection", (socket) => {
  console.log("a user connected:", socket.id);

  socket.on("createRoom", (data, cb) => {
    const { maxPlayers, password } = data;
    if (
      typeof maxPlayers !== "number" ||
      maxPlayers < 2 ||
      typeof password !== "string"
    ) {
      return cb({ status: "error", message: "Invalid room options." });
    }

    let room;
    do {
      room = makeRoomId();
    } while (roomsMeta.has(room));

    roomsMeta.set(room, { maxPlayers, password });
    socket.join(room);
    console.log(`Room ${room} created (max=${maxPlayers}) by ${socket.id}`);
    cb({ status: "ok", room });
  });

  socket.on("joinRoom", (data, cb) => {
    const { room, password } = data;
    const meta = roomsMeta.get(room);

    if (!meta) {
      return cb({ status: "error", message: "Room not found." });
    }
    if (password !== meta.password) {
      return cb({ status: "error", message: "Wrong password." });
    }

    const clients = io.sockets.adapter.rooms.get(room);
    const count = clients ? clients.size : 0;
    if (count >= meta.maxPlayers) {
      return cb({ status: "error", message: "Room is full." });
    }

    socket.join(room);
    console.log(
      `${socket.id} joined room ${room} (${count + 1}/${meta.maxPlayers})`
    );
    cb({ status: "ok", room });
  });

  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id);
    for (const [room, { maxPlayers }] of roomsMeta) {
      const clients = io.sockets.adapter.rooms.get(room);
      if (!clients || clients.size === 0) {
        roomsMeta.delete(room);
        console.log(`Room ${room} deleted (empty)`);
      }
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
