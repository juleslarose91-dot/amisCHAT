const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
// IMPORTANT: set OWNER_CODE in Render environment variables. Do not put it in index.html.
const OWNER_CODE = process.env.OWNER_CODE || "";
const usersByName = new Map();
const groupsByCode = new Map();

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "AmiChat" }));

io.on("connection", (socket) => {
  socket.data.name = "Utilisateur";
  socket.data.language = "FR";
  socket.data.isOwner = false;

  socket.on("joinServer", (data = {}) => {
    const name = String(data.name || "Utilisateur").trim().slice(0, 20) || "Utilisateur";
    const age = Number(data.age);
    if (!Number.isFinite(age) || age < 10) {
      socket.emit("serverError", { message: "AmiChat est réservé aux personnes de 10 ans et plus." });
      return;
    }
    socket.data.name = name;
    socket.data.language = data.language === "EN" ? "EN" : "FR";
    usersByName.set(name.toLowerCase(), socket.id);
    socket.emit("presence", { users: [] });
  });

  // Owner verification happens on the server.
  socket.on("ownerLogin", (data = {}) => {
    const code = String(data.code || "");
    if (!OWNER_CODE) {
      socket.emit("ownerStatus", { ok: false, message: "Code propriétaire non configuré sur le serveur." });
      return;
    }
    if (code === OWNER_CODE) {
      socket.data.isOwner = true;
      socket.emit("ownerStatus", { ok: true });
    } else {
      socket.emit("ownerStatus", { ok: false, message: "Accès refusé." });
    }
  });

  socket.on("joinRoom", (data = {}) => {
    const room = String(data.room || "PUBLIC").slice(0, 40);
    socket.join(room);
  });

  socket.on("chatMessage", (data = {}) => {
    const room = String(data.room || "PUBLIC").slice(0, 40);
    const text = String(data.text || "").trim().slice(0, 300);
    if (!text) return;
    io.to(room).emit("chatMessage", {
      text,
      name: socket.data.name,
      isOwner: socket.data.isOwner
    });
  });

  socket.on("createGroup", (data = {}) => {
    const name = String(data.name || "").trim().slice(0, 24);
    if (!name) return;
    let code = "";
    do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (groupsByCode.has(code));
    const group = { name, code, owner: socket.data.name, members: new Set([socket.data.name.toLowerCase()]) };
    groupsByCode.set(code, group);
    socket.join("GROUP_" + code);
    socket.emit("groupCreated", { name, code });
  });

  socket.on("joinGroupByCode", (data = {}) => {
    const code = String(data.code || "").trim().toUpperCase().slice(0, 12);
    const group = groupsByCode.get(code);
    if (!group) { socket.emit("serverError", { message: "Ce code de groupe n'existe pas ou n'est plus disponible." }); return; }
    group.members.add(String(socket.data.name).toLowerCase());
    socket.join("GROUP_" + code);
    socket.emit("groupJoined", { name: group.name, code: group.code });
    io.to("GROUP_" + code).emit("groupMemberJoined", { name: socket.data.name, group: group.name });
  });

  socket.on("gameInvite", (data = {}) => {
    const to = String(data.to || "").trim().slice(0,20);
    const game = String(data.game || "");
    if (!to || game !== "morpion") return;
    const targetId = usersByName.get(to.toLowerCase());
    if (!targetId) {
      socket.emit("serverError", { message: "Cet ami n'est pas connecté actuellement." });
      return;
    }
    io.to(targetId).emit("gameInvite", {
      from: socket.data.name,
      game: "morpion",
      room: `MORPION_${socket.id}_${targetId}`
    });
  });

  socket.on("disconnect", () => {
    if (socket.data.name) {
      const key = String(socket.data.name).toLowerCase();
      if (usersByName.get(key) === socket.id) usersByName.delete(key);
    }
  });
});

server.listen(PORT, () => console.log(`AmiChat server listening on ${PORT}`));
