const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
// Code propriétaire : compatible avec Render via OWNER_CODE ou MODERATION_CODE.
const OWNER_CODE = process.env.OWNER_CODE || process.env.MODERATION_CODE || "admin1961";
const usersByName = new Map();
const requestsByUser = new Map();
const friendsByUser = new Map();
const messagesByRoom = new Map();
// Invitations de mini-jeux en attente (pour transmettre la même partie aux deux amis).
const gameInvites = new Map();
const fs = require("fs");
const DATA_FILE = path.join(__dirname, "amichat-data.json");

function loadPersistentState(){
  try{
    if(!fs.existsSync(DATA_FILE)) return;
    const data=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
    for(const [k,v] of Object.entries(data.requests||{})) requestsByUser.set(k,new Set(v));
    for(const [k,v] of Object.entries(data.friends||{})) friendsByUser.set(k,new Set(v));
    for(const [k,v] of Object.entries(data.messages||{})) if(k!=="PUBLIC") messagesByRoom.set(k,Array.isArray(v)?v:[]);
  }catch(e){ console.warn("Could not load AmiChat data:",e.message); }
}
function savePersistentState(){
  try{
    const obj={requests:{},friends:{},messages:{}};
    for(const [k,v] of requestsByUser) obj.requests[k]=[...v];
    for(const [k,v] of friendsByUser) obj.friends[k]=[...v];
    for(const [k,v] of messagesByRoom) if(k!=="PUBLIC") obj.messages[k]=v;
    const tmp=DATA_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(obj));
    fs.renameSync(tmp,DATA_FILE);
  }catch(e){ console.warn("Could not save AmiChat data:",e.message); }
}
loadPersistentState();

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

function broadcastPresence(){
  io.emit("presence",{
    users:[...usersByName.values()]
      .map(id=>io.sockets.sockets.get(id)?.data?.name)
      .filter(Boolean)
  });
}


function renamePersistentUser(oldName,newName,socket){
  const oldKey=key(oldName), newKey=key(newName);
  if(!oldKey || !newKey || oldKey===newKey) return true;
  const existing=usersByName.get(newKey);
  if(existing && existing!==socket.id){ socket.emit("serverError",{message:"Ce pseudo est déjà utilisé."}); return false; }
  const oldRequests=requestsByUser.get(oldKey);
  const oldFriends=friendsByUser.get(oldKey);
  if(oldRequests){ requestsByUser.delete(oldKey); requestsByUser.set(newKey,new Set(oldRequests)); }
  if(oldFriends){ friendsByUser.delete(oldKey); friendsByUser.set(newKey,new Set(oldFriends)); }
  for(const set of requestsByUser.values()) if(set.has(oldKey)){ set.delete(oldKey); set.add(newKey); }
  for(const set of friendsByUser.values()) if(set.has(oldKey)){ set.delete(oldKey); set.add(newKey); }
  for(const history of messagesByRoom.values()) for(const msg of history) if(key(msg.name)===oldKey) msg.name=newName;
  if(usersByName.get(oldKey)===socket.id) usersByName.delete(oldKey);
  usersByName.set(newKey,socket.id);
  socket.data.name=newName;
  savePersistentState();
  broadcastPresence();
  return true;
}

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
    broadcastPresence();
    sendState(socket);
    socket.emit("serverReady",{name});
  });

  socket.on("updateProfile", data=>{
    const newName=String(data?.name||socket.data.name||"").trim().slice(0,20);
    if(!newName) return;
    renamePersistentUser(socket.data.name,newName,socket);
    socket.emit("profileUpdated",{name:socket.data.name});
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
    socket.emit("chatHistory", {room, messages: room==="PUBLIC" ? [] : [...(messagesByRoom.get(room)||[])]});
  });

  socket.on("chatMessage", data=>{
    const room=String(data.room||"PUBLIC").slice(0,80);
    const text=String(data.text||"").trim().slice(0,300); if(!text)return;
    const message={id:Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8),text,name:socket.data.name,isOwner:socket.data.isOwner};
    /* Le chat public est temporaire : il n'est jamais gardé dans l'historique. */
    if(room!=="PUBLIC"){
      const history=messagesByRoom.get(room)||[]; history.push(message);
      if(history.length>200) history.shift();
      messagesByRoom.set(room,history);
      savePersistentState();
    }
    socket.to(room).emit("chatMessage",{...message,room});
  });

  socket.on("friendRequest", data=>{
    if(!socket.data.name || socket.data.name==="Utilisateur"){socket.emit("serverError",{message:"Connecte-toi au serveur AmiChat avant d'envoyer une demande."});return;}
    const to=String(data.to||"").trim().slice(0,20), target=key(to), from=key(socket.data.name);
    if(!target)return;
    if(target===from){socket.emit("serverError",{message:"Tu ne peux pas t'ajouter toi-même 😊"});return;}
    if(!usersByName.has(target)){socket.emit("serverError",{message:"Ce pseudo n'est pas connecté actuellement."});return;}
    if((friendsByUser.get(from)||new Set()).has(target)){socket.emit("serverError",{message:"Vous êtes déjà amis ❤️"});return;}
    getSet(requestsByUser,target).add(from);
    savePersistentState();
    const targetSocket=io.sockets.sockets.get(usersByName.get(target));
    if(targetSocket){ targetSocket.emit("friendRequest",{from:socket.data.name}); sendState(targetSocket); }
    socket.emit("friendRequestSent",{to:displayName(to)});
  });

  socket.on("acceptFriendRequest", data=>{
    const from=key(data.from), me=key(socket.data.name);
    if(!from||!me)return;
    getSet(requestsByUser,me).delete(from);
    getSet(friendsByUser,me).add(from); getSet(friendsByUser,from).add(me);
    savePersistentState();
    sendState(socket);
    const otherId=usersByName.get(from), other=otherId&&io.sockets.sockets.get(otherId);
    if(other){ other.emit("friendAccepted",{from:socket.data.name}); sendState(other); }
    socket.emit("friendAccepted",{from:displayName(from)});
  });

  socket.on("refuseFriendRequest", data=>{
    const from=key(data.from), me=key(socket.data.name);
    if(!from||!me)return;
    getSet(requestsByUser,me).delete(from);
    savePersistentState();
    sendState(socket);
    const otherId=usersByName.get(from), other=otherId&&io.sockets.sockets.get(otherId);
    if(other) other.emit("friendRefused",{from:socket.data.name});
  });

  socket.on("gameInvite", data=>{
    const to=String(data.to||"").trim().slice(0,20), game=String(data.game||""); if(!to||!game)return;
    const targetId=usersByName.get(key(to));
    if(!targetId){socket.emit("serverError",{message:"Cet ami n'est pas connecté actuellement."});return;}
    const room=`GAME_${socket.id}_${targetId}_${Date.now().toString(36)}`;
    const inviteKey=`${key(socket.data.name)}|${key(to)}|${game}`;
    gameInvites.set(inviteKey,room);
    io.to(targetId).emit("gameInvite",{from:socket.data.name,game,room});
  });

  socket.on("gameInviteResponse", data=>{
    const to=String(data?.to||"").trim().slice(0,20);
    const game=String(data?.game||"");
    if(!to||!game)return;
    const targetId=usersByName.get(key(to));
    const inviteKey=`${key(to)}|${key(socket.data.name)}|${game}`;
    const room=String(data?.room||gameInvites.get(inviteKey)||"");
    const accepted=!!data?.accepted;
    if(!targetId||!room) return;
    if(accepted){
      socket.join(room);
      const other=io.sockets.sockets.get(targetId);
      if(other) other.join(room);
    }
    io.to(targetId).emit("gameInviteResponse",{from:socket.data.name,game,accepted,room});
    socket.emit("gameInviteResponse",{from:to,game,accepted,room,me:true});
    gameInvites.delete(inviteKey);
  });

  socket.on("gameAction", data=>{
    const room=String(data?.room||""); if(!room.startsWith("GAME_")) return;
    socket.to(room).emit("gameAction",{game:String(data?.game||""),type:String(data?.type||""),value:data?.value,from:socket.data.name});
  });

  socket.on("disconnect",()=>{
    const k=key(socket.data.name);
    if(usersByName.get(k)===socket.id) usersByName.delete(k);
    broadcastPresence();
  });
});

server.listen(PORT,()=>console.log(`AmiChat server listening on ${PORT}`));
