const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const OWNER_CODE = process.env.OWNER_CODE || "";

const usersByName = new Map();          // lowercase name -> socket id
const groupsByCode = new Map();         // code -> group
const pendingRequests = new Map();      // lowercase recipient -> Set(sender)
const friendships = new Map();          // lowercase user -> Set(friend lowercase)

function addFriendship(a,b){
  a=String(a).toLowerCase(); b=String(b).toLowerCase();
  if(!friendships.has(a)) friendships.set(a,new Set());
  if(!friendships.has(b)) friendships.set(b,new Set());
  friendships.get(a).add(b); friendships.get(b).add(a);
}
function removeRequest(to, from){
  const set=pendingRequests.get(to);
  if(!set) return;
  set.delete(from);
  if(!set.size) pendingRequests.delete(to);
}
function displayNameFor(key){
  const id=usersByName.get(String(key).toLowerCase());
  const s=id && io.sockets.sockets.get(id);
  return s?.data?.name || String(key);
}

app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/health", (_req,res)=>res.json({ok:true,service:"AmiChat"}));

io.on("connection",(socket)=>{
  socket.data.name="Utilisateur";
  socket.data.language="FR";
  socket.data.isOwner=false;

  socket.on("joinServer",(data={})=>{
    const name=String(data.name||"Utilisateur").trim().slice(0,20)||"Utilisateur";
    const age=Number(data.age);
    if(!Number.isFinite(age)||age<10){
      socket.emit("serverError",{message:"AmiChat est réservé aux personnes de 10 ans et plus."});
      return;
    }
    // If the same username was connected elsewhere, replace the old session.
    const key=name.toLowerCase();
    const oldId=usersByName.get(key);
    if(oldId && oldId!==socket.id){
      const old=io.sockets.sockets.get(oldId);
      if(old) old.disconnect(true);
    }
    socket.data.name=name;
    socket.data.language=data.language==="EN"?"EN":"FR";
    usersByName.set(key,socket.id);
    socket.join("PUBLIC");

    const online=[...usersByName.keys()].map(k=>displayNameFor(k)).filter(Boolean);
    io.emit("presence",{users:online});

    const pending=[...(pendingRequests.get(key)||[])].map(from=>({
      from:displayNameFor(from), to:name
    }));
    pending.forEach(req=>socket.emit("friendRequest",req));

    const friends=[...(friendships.get(key)||[])].map(displayNameFor);
    socket.emit("serverReady",{name, friends, pending});
  });

  socket.on("ownerLogin",(data={})=>{
    const code=String(data.code||"");
    if(!OWNER_CODE){ socket.emit("ownerStatus",{ok:false,message:"Code propriétaire non configuré sur le serveur."}); return; }
    if(code===OWNER_CODE){ socket.data.isOwner=true; socket.emit("ownerStatus",{ok:true}); }
    else socket.emit("ownerStatus",{ok:false,message:"Accès refusé."});
  });

  socket.on("joinRoom",(data={})=>{
    const room=String(data.room||"PUBLIC").slice(0,60);
    socket.join(room);
  });

  socket.on("chatMessage",(data={})=>{
    const room=String(data.room||"PUBLIC").slice(0,60);
    const text=String(data.text||"").trim().slice(0,300);
    if(!text) return;
    io.to(room).emit("chatMessage",{
      text,name:socket.data.name,isOwner:socket.data.isOwner
    });
  });

  socket.on("friendRequest",(data={})=>{
    const to=String(data.to||"").trim().slice(0,20);
    const from=socket.data.name;
    if(!to || !from || to.toLowerCase()===from.toLowerCase()){
      socket.emit("friendRequestResult",{ok:false,message:"Pseudo invalide."}); return;
    }
    const targetId=usersByName.get(to.toLowerCase());
    // The recipient may be offline: keep the request on the server.
    const recipientKey=to.toLowerCase();
    const fromKey=from.toLowerCase();
    const existingFriends=friendships.get(fromKey);
    if(existingFriends?.has(recipientKey)){
      socket.emit("friendRequestResult",{ok:false,message:"Vous êtes déjà amis."}); return;
    }
    if(!pendingRequests.has(recipientKey)) pendingRequests.set(recipientKey,new Set());
    pendingRequests.get(recipientKey).add(fromKey);
    socket.emit("friendRequestResult",{ok:true,to});
    if(targetId){
      io.to(targetId).emit("friendRequest",{from,to});
    }
  });

  socket.on("acceptFriendRequest",(data={})=>{
    const from=String(data.from||"").trim().slice(0,20);
    const me=socket.data.name;
    const meKey=me.toLowerCase(), fromKey=from.toLowerCase();
    const set=pendingRequests.get(meKey);
    if(!set?.has(fromKey)){ socket.emit("serverError",{message:"Cette demande n'est plus disponible."}); return; }
    removeRequest(meKey,fromKey);
    addFriendship(me,from);
    socket.emit("friendAccepted",{friend:displayNameFor(fromKey)});
    const senderId=usersByName.get(fromKey);
    if(senderId) io.to(senderId).emit("friendAccepted",{friend:me});
  });

  socket.on("rejectFriendRequest",(data={})=>{
    const from=String(data.from||"").trim().slice(0,20);
    const me=socket.data.name;
    removeRequest(me.toLowerCase(),from.toLowerCase());
    socket.emit("friendRejected",{from});
    const senderId=usersByName.get(from.toLowerCase());
    if(senderId) io.to(senderId).emit("friendRejected",{from:me});
  });

  socket.on("createGroup",(data={})=>{
    const name=String(data.name||"").trim().slice(0,24);
    if(!name){socket.emit("serverError",{message:"Choisis un nom pour le groupe."});return;}
    let code="";
    do{code=Math.random().toString(36).slice(2,8).toUpperCase();}while(groupsByCode.has(code));
    const group={name,code,owner:socket.data.name,members:new Set([socket.data.name.toLowerCase()])};
    groupsByCode.set(code,group);
    socket.join("GROUP_"+code);
    socket.emit("groupCreated",{name,code});
  });

  socket.on("joinGroupByCode",(data={})=>{
    const code=String(data.code||"").trim().toUpperCase().slice(0,12);
    const group=groupsByCode.get(code);
    if(!group){socket.emit("serverError",{message:"Ce code de groupe n'existe pas ou n'est plus disponible."});return;}
    group.members.add(socket.data.name.toLowerCase());
    socket.join("GROUP_"+code);
    socket.emit("groupJoined",{name:group.name,code:group.code});
    io.to("GROUP_"+code).emit("groupMemberJoined",{name:socket.data.name,group:group.name});
  });

  socket.on("gameInvite",(data={})=>{
    const to=String(data.to||"").trim().slice(0,20);
    if(!to || String(data.game||"")!=="morpion") return;
    const targetId=usersByName.get(to.toLowerCase());
    if(!targetId){socket.emit("serverError",{message:"Cet ami n'est pas connecté actuellement."});return;}
    io.to(targetId).emit("gameInvite",{
      from:socket.data.name,game:"morpion",room:`MORPION_${socket.id}_${targetId}`
    });
  });

  socket.on("disconnect",()=>{
    const key=String(socket.data.name||"").toLowerCase();
    if(usersByName.get(key)===socket.id){
      usersByName.delete(key);
      io.emit("presence",{users:[...usersByName.keys()].map(displayNameFor)});
    }
  });
});

server.listen(PORT,()=>console.log(`AmiChat server listening on ${PORT}`));
