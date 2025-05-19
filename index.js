const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { randomBytes, randomUUID } = require("crypto");
const admin = require("firebase-admin");
const serviceAccount = require("./ridethebus-5f1d9-firebase-adminsdk-fbsvc-d5a5db17b4.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ridethebus-5f1d9-default-rtdb.firebaseio.com/",
});

const db = admin.database();

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

// room metadata: Map<roomId, { password, maxPlayers, hostToken, users: Map<token, { socketId, name, connected }> }>
const roomsMeta = new Map();

function makeRoomId() {
  return randomBytes(3).toString("hex").toUpperCase();
}

app.get("/", (req, res) => {
  res.send(`Ride the Bus server is running on port ${port}`);
});

async function broadcastUserList(room) {
  const snap = await roomRef(room).once("value");
  if (!snap.exists()) return;

  const meta = snap.val();
  const users = Object.entries(meta.users || {}).map(([token, u]) => ({
    token,
    name: u.name,
    connected: u.connected,
    isHost: token === meta.hostToken,
  }));

  io.to(room).emit("userList", users);
}

function roomRef(roomId) {
  return db.ref(`rooms/${roomId}`);
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("createRoom", async (data, cb) => {
    const { userId, name, maxPlayers, password } = data;

    // 1) Validate
    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof name !== "string" ||
      !name.trim() ||
      typeof password !== "string" ||
      typeof maxPlayers !== "number" ||
      maxPlayers < 2
    ) {
      return cb({ status: "error", message: "Invalid createRoom params." });
    }

    // 2) Generate unique room code
    let room, snap;
    do {
      room = makeRoomId();
      snap = await roomRef(room).once("value");
    } while (snap.exists());

    // 3) Use client’s userId as hostToken
    const hostToken = userId;
    const initial = {
      password,
      maxPlayers,
      hostToken,
      gameStarted: false,
      users: {
        [hostToken]: {
          socketId: socket.id,
          name: name.trim(),
          connected: true,
          joinedAt: Date.now(),
        },
      },
    };

    // 4) Persist to Firebase & join Socket room
    await roomRef(room).set(initial);
    socket.join(room);

    // 5) Ack back
    cb({ status: "ok", room, token: hostToken });
    broadcastUserList(room);
  });

  // Join or rejoin room
  socket.on("joinRoom", async (data, cb) => {
    const { userId, name, roomCode: room, password } = data;
    const rRef = roomRef(room);
    const snap = await rRef.once("value");

    if (!snap.exists()) {
      return cb({ status: "error", message: "Room not found." });
    }
    const meta = snap.val();
    if (password !== meta.password) {
      return cb({ status: "error", message: "Wrong password." });
    }

    const users = meta.users || {};
    const connectedCount = Object.values(users).filter(
      (u) => u.connected
    ).length;
    const isRejoin = userId && users[userId];

    if (!isRejoin && connectedCount >= meta.maxPlayers) {
      return cb({ status: "error", message: "Room is full." });
    }

    const userToken = isRejoin ? userId : userId;
    users[userToken] = { socketId: socket.id, name, connected: true };

    await rRef.child("users").set(users);
    socket.join(room);

    cb({ status: "ok", room, token: userToken });
    broadcastUserList(room);
  });

  // Host starts the game
  socket.on("startGame", async ({ token, room }, cb) => {
    const snap = await roomRef(room).once("value");
    if (!snap.exists())
      return cb({ status: "error", message: "Room not found." });

    const meta = snap.val();
    if (token !== meta.hostToken) {
      return cb({ status: "error", message: "Only host can start." });
    }

    // mark game started
    await roomRef(room).update({ gameStarted: true });
    io.to(room).emit("gameStarted");
    cb({ status: "ok" });
  });

  // Host removes a player
  socket.on("removePlayer", async ({ token, room, removeToken }, cb) => {
    const snap = await roomRef(room).once("value");
    if (!snap.exists())
      return cb({ status: "error", message: "Room not found." });

    const meta = snap.val();
    if (token !== meta.hostToken) {
      return cb({ status: "error", message: "Only host can remove players." });
    }

    const user = meta.users?.[removeToken];
    if (!user) return cb({ status: "error", message: "User not found." });

    // kick them
    io.to(user.socketId).emit("kicked");
    io.sockets.sockets.get(user.socketId)?.leave(room);

    // remove from users object
    delete meta.users[removeToken];
    await roomRef(room).child("users").set(meta.users);

    cb({ status: "ok" });
    broadcastUserList(room);
  });

  // Handle disconnect and host promotion
  socket.on("disconnect", async () => {
    // iterate all rooms in DB to find where this socket lived
    const roomsSnap = await db.ref("rooms").once("value");
    if (!roomsSnap.exists()) return;

    const rooms = roomsSnap.val();
    for (const [roomId, meta] of Object.entries(rooms)) {
      let changed = false;

      // find the user entry by socketId
      for (const [token, u] of Object.entries(meta.users || {})) {
        if (u.socketId === socket.id) {
          meta.users[token].connected = false;
          changed = true;

          // if they were host, re-elect next
          if (meta.hostToken === token) {
            const tokens = Object.keys(meta.users);
            const idx = tokens.indexOf(token);
            meta.hostToken = tokens[idx + 1] || tokens[0];
          }
          break;
        }
      }

      if (!changed) continue;

      const everyoneOffline = Object.values(meta.users).every(
        (u) => !u.connected
      );
      if (everyoneOffline) {
        await roomRef(roomId).update({
          users: meta.users,
          hostToken: meta.hostToken,
        });
      } else {
        await roomRef(roomId).update({
          users: meta.users,
          hostToken: meta.hostToken,
        });
      }

      broadcastUserList(roomId);
    }
  });
});

server.listen(port, () => console.log(`Server running on port ${port}`));
