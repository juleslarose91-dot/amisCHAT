const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const OWNER_CODE = process.env.OWNER_CODE || "";
const usersByName = new Map();
const requestsByUser = new Map();
const friendsByUser = new Map();
const messagesByRoom = new Map();

function key(name){ return String(name || "").trim().toLowerCase(); }
function displayName(name){ const id=key(name); const sock=usersByName.get(id); return sock?.data?.name || String(name||"").trim().slice(0,20); }
function getSet(map,k){ if(!map.has(k)) map.set(k,new Set()); return map.get(k); }
function sendState(socket){
  const k=key(socket.data.name);
  socket.emit("socialState", {
    requests:[...(requestsByUser.get(k)||[])].map(displayName),
    friends:[...(friendsByUser.get(k)||[])].map(displayName)
  });
}
function friendRoom(a,b){ return "FRIEND_"+[key(a),key(b)].sort().join("_").slice(0,80); }

app.get("/", (_req,res) => res.sendFile(path.join(__dirname,"index.html")));
app.get("/health", (_req,res) => res.json({ok:true,service:"AmiChat"}));

io.on("connection", socket => {
  socket.data.name="Utilisateur"; socket.data.language="FR"; socket.data.isOwner=false;

  socket.on("joinServer", (data={}) => {
    const name=String(data.name||"Utilisateur").trim().slice(0,20) || "Utilisateur";
    const age=Number(data.age);
    if(!Number.isFinite(age)||age<10){ socket.emit("serverError",{message:"AmiChat est réservé aux personnes de 10 ans et plus."}); return; }
    const k=key(name);
    const old=usersByName.get(k);
    if(old && old!==socket.id) io.to(old).emit("serverError",{message:"Cette session a été remplacée par une nouvelle connexion."});
    socket.data.name=name; socket.data.age=age; socket.data.language=data.language==="EN"?"EN":"FR";
    usersByName.set(k,socket.id);
    getSet(requestsByUser,k); getSet(friendsByUser,k);
    socket.emit("presence",{users:[...usersByName.values()].map(id=>io.sockets.sockets.get(id)?.data?.name).filter(Boolean)});
    sendState(socket);
    socket.emit("serverReady",{name});
  });

  socket.on("ownerLogin", data=>{
    const code=String(data.code||"");
    if(!OWNER_CODE){socket.emit("ownerStatus",{ok:false,message:"Code propriétaire non configuré sur le serveur."});return;}
    if(code===OWNER_CODE){socket.data.isOwner=true;socket.emit("ownerStatus",{ok:true});}
    else socket.emit("ownerStatus",{ok:false,message:"Accès refusé."});
  });

  socket.on("joinRoom", data=>{
    const room=String(data.room||"PUBLIC").slice(0,80);
    socket.join(room);
    socket.emit("chatHistory", {room, messages:[...(messagesByRoom.get(room)||[])]});
  });

  socket.on("chatMessage", data=>{
    const room=String(data.room||"PUBLIC").slice(0,80);
    const text=String(data.text||"").trim().slice(0,300); if(!text)return;
    const message={text,name:socket.data.name,isOwner:socket.data.isOwner};
    const history=messagesByRoom.get(room)||[]; history.push(message);
    if(history.length>200) history.shift();
    messagesByRoom.set(room,history);
    io.to(room).emit("chatMessage",message);
  });

  socket.on("friendRequest", data=>{
    if(!socket.data.name || socket.data.name==="Utilisateur"){socket.emit("serverError",{message:"Connecte-toi au serveur AmiChat avant d'envoyer une demande."});return;}
    const to=String(data.to||"").trim().slice(0,20), target=key(to), from=key(socket.data.name);
    if(!target)return;
    if(target===from){socket.emit("serverError",{message:"Tu ne peux pas t'ajouter toi-même 😊"});return;}
    if(!usersByName.has(target)){socket.emit("serverError",{message:"Ce pseudo n'est pas connecté actuellement."});return;}
    if((friendsByUser.get(from)||new Set()).has(target)){socket.emit("serverError",{message:"Vous êtes déjà amis ❤️"});return;}
    getSet(requestsByUser,target).add(from);
    const targetSocket=io.sockets.sockets.get(usersByName.get(target));
    if(targetSocket){ targetSocket.emit("friendRequest",{from:socket.data.name}); sendState(targetSocket); }
    socket.emit("friendRequestSent",{to:displayName(to)});
  });

  socket.on("acceptFriendRequest", data=>{
    const from=key(data.from), me=key(socket.data.name);
    if(!from||!me)return;
    getSet(requestsByUser,me).delete(from);
    getSet(friendsByUser,me).add(from); getSet(friendsByUser,from).add(me);
    sendState(socket);
    const otherId=usersByName.get(from), other=otherId&&io.sockets.sockets.get(otherId);
    if(other){ other.emit("friendAccepted",{from:socket.data.name}); sendState(other); }
    socket.emit("friendAccepted",{from:displayName(from)});
  });

  socket.on("refuseFriendRequest", data=>{
    const from=key(data.from), me=key(socket.data.name);
    if(!from||!me)return;
    getSet(requestsByUser,me).delete(from);
    sendState(socket);
    const otherId=usersByName.get(from), other=otherId&&io.sockets.sockets.get(otherId);
    if(other) other.emit("friendRefused",{from:socket.data.name});
  });

  socket.on("gameInvite", data=>{
    const to=String(data.to||"").trim().slice(0,20), game=String(data.game||""); if(!to||!game)return;
    const targetId=usersByName.get(key(to)); if(!targetId){socket.emit("serverError",{message:"Cet ami n'est pas connecté actuellement."});return;}
    io.to(targetId).emit("gameInvite",{from:socket.data.name,game,room:`MORPION_${socket.id}_${targetId}`});
  });

  socket.on("disconnect",()=>{ const k=key(socket.data.name); if(usersByName.get(k)===socket.id) usersByName.delete(k); });
});

server.listen(PORT,()=>console.log(`AmiChat server listening on ${PORT}`));
