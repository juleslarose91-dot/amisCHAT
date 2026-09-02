const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const OWNER_CODE = process.env.OWNER_CODE || "";

const DATA_FILE = path.join(__dirname, "amichat-data.json");
let data = { users: {}, requests: [], friendships: [] };
try { if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch(e) {}
data.users ||= {}; data.requests ||= []; data.friendships ||= [];
function saveData(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e) { console.error("saveData",e); } }

const usersByName = new Map();
const norm = s => String(s||"").trim().toLowerCase();
function pairKey(a,b){ return [norm(a),norm(b)].sort().join("::"); }
function areFriends(a,b){ return data.friendships.includes(pairKey(a,b)); }
function pending(a,b){ return data.requests.some(r=>r.from===norm(a)&&r.to===norm(b)); }
function sendUserState(socket){
  const me=norm(socket.data.name);
  const friends= data.friendships
    .filter(k=>k.includes("::"+me) || k.startsWith(me+"::"))
    .map(k=>k.split("::").find(x=>x!==me))
    .filter(Boolean);
  const requests=data.requests.filter(r=>r.to===me).map(r=>({from:r.from, createdAt:r.createdAt}));
  socket.emit("friendState",{friends,requests});
}
function emitToName(name,event,payload){
  const id=usersByName.get(norm(name));
  if(id) io.to(id).emit(event,payload);
}

app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/health", (_req,res)=>res.json({ok:true,service:"AmiChat"}));

io.on("connection",(socket)=>{
  socket.data.name="Utilisateur";
  socket.data.language="FR";
  socket.data.isOwner=false;

  socket.on("joinServer",(input={})=>{
    const name=String(input.name||"Utilisateur").trim().slice(0,20)||"Utilisateur";
    const age=Number(input.age);
    if(!Number.isFinite(age)||age<10){
      socket.emit("serverError",{message:"AmiChat est réservé aux personnes de 10 ans et plus."}); return;
    }
    socket.data.name=name;
    socket.data.language=input.language==="EN"?"EN":"FR";
    const key=norm(name);
    usersByName.set(key,socket.id);
    data.users[key]={name,age,language:socket.data.language,lastSeen:Date.now()};
    saveData();
    sendUserState(socket);
    io.emit("presence",{users:[...usersByName.keys()]});
  });

  socket.on("ownerLogin",(input={})=>{
    const code=String(input.code||"");
    if(!OWNER_CODE){socket.emit("ownerStatus",{ok:false,message:"Code propriétaire non configuré sur le serveur."});return;}
    if(code===OWNER_CODE){socket.data.isOwner=true;socket.emit("ownerStatus",{ok:true});}
    else socket.emit("ownerStatus",{ok:false,message:"Accès refusé."});
  });

  socket.on("joinRoom",(input={})=>{
    const room=String(input.room||"PUBLIC").slice(0,80);
    socket.join(room);
  });
  socket.on("leaveRoom",(input={})=>{
    const room=String(input.room||"").slice(0,80);
    if(room) socket.leave(room);
  });

  socket.on("chatMessage",(input={})=>{
    const room=String(input.room||"PUBLIC").slice(0,80);
    const text=String(input.text||"").trim().slice(0,300);
    if(!text)return;
    io.to(room).emit("chatMessage",{text,name:socket.data.name,isOwner:socket.data.isOwner});
  });

  socket.on("friendRequest",(input={})=>{
    const to=String(input.to||"").trim().slice(0,20);
    const from=socket.data.name;
    if(!to || norm(to)===norm(from)) return;
    const target=data.users[norm(to)];
    if(!target){socket.emit("friendResult",{ok:false,message:"Ce pseudo n'existe pas encore sur AmiChat."});return;}
    if(areFriends(from,to)){socket.emit("friendResult",{ok:false,message:"Vous êtes déjà amis."});return;}
    if(pending(from,to)){socket.emit("friendResult",{ok:false,message:"Cette demande est déjà en attente."});return;}
    // Remove the opposite pending request and turn it into friendship.
    if(pending(to,from)){
      data.requests=data.requests.filter(r=>!(r.from===norm(to)&&r.to===norm(from)));
      data.friendships.push(pairKey(from,to)); saveData();
      emitToName(to,"friendState",null); sendUserState(socket); emitToName(to,"friendResult",{ok:true,message:`🎉 ${from} et toi êtes maintenant amis !`});
      socket.emit("friendResult",{ok:true,message:`🎉 ${to} et toi êtes maintenant amis !`});
      return;
    }
    data.requests.push({from:norm(from),to:norm(to),createdAt:Date.now()}); saveData();
    emitToName(to,"friendRequest",{from});
    socket.emit("friendResult",{ok:true,message:`💌 Demande envoyée à ${to}. Elle restera en attente jusqu'à sa réponse.`});
  });

  socket.on("friendResponse",(input={})=>{
    const from=norm(input.from), accept=!!input.accept, me=norm(socket.data.name);
    const idx=data.requests.findIndex(r=>r.from===from&&r.to===me);
    if(idx<0)return;
    data.requests.splice(idx,1);
    if(accept) data.friendships.push(pairKey(from,me));
    saveData();
    sendUserState(socket);
    emitToName(from,"friendResult",{ok:true,accepted:accept,from:socket.data.name,message:accept?`🎉 ${socket.data.name} a accepté ta demande d'ami !`:`Demande d'ami refusée.`});
    if(accept) emitToName(from,"friendState",null);
  });

  socket.on("gameInvite",(input={})=>{
    const to=String(input.to||"").trim().slice(0,20), game=String(input.game||"");
    if(!to||game!=="morpion")return;
    const targetId=usersByName.get(norm(to));
    if(!targetId){socket.emit("serverError",{message:"Cet ami n'est pas connecté actuellement."});return;}
    io.to(targetId).emit("gameInvite",{from:socket.data.name,game:"morpion",room:`MORPION_${pairKey(socket.data.name,to)}`});
  });

  socket.on("disconnect",()=>{
    const key=norm(socket.data.name);
    if(usersByName.get(key)===socket.id)usersByName.delete(key);
    io.emit("presence",{users:[...usersByName.keys()]});
  });
});

server.listen(PORT,()=>console.log(`AmiChat server listening on ${PORT}`));
