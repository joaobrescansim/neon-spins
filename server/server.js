const express=require('express');
const Database=require('better-sqlite3');
const crypto=require('crypto');
const path=require('path');
const app=express();
const db=new Database(path.join(__dirname,'neon-spins.db'));
app.use(express.json()); app.use(express.static(path.join(__dirname,'../public')));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'player',balance INTEGER NOT NULL DEFAULT 10000,
 status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS games(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'active',
 rtp_demo REAL NOT NULL DEFAULT 96,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bets(
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,game_id INTEGER,bet INTEGER,prize INTEGER,
 reels TEXT,multiplier INTEGER,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,type TEXT,amount INTEGER,description TEXT,created_at TEXT NOT NULL
);
`);
const hash=p=>crypto.createHash('sha256').update(p).digest('hex');
const now=()=>new Date().toISOString();
function seed(){
 if(!db.prepare('SELECT 1 FROM users LIMIT 1').get()){
  db.prepare('INSERT INTO users(name,email,password_hash,role,balance,created_at) VALUES(?,?,?,?,?,?)')
   .run('Demo Player','demo@local.test',hash('demo123'),'player',10000,now());
  db.prepare('INSERT INTO users(name,email,password_hash,role,balance,created_at) VALUES(?,?,?,?,?,?)')
   .run('Administrador','admin@local.test',hash('admin123'),'admin',0,now());
 }
 if(!db.prepare('SELECT 1 FROM games LIMIT 1').get()){
  const ins=db.prepare('INSERT INTO games(name,rtp_demo,created_at) VALUES(?,?,?)');
  ['Neon Fruits','Cyber 7','Diamond Rush'].forEach((g,i)=>ins.run(g,[96,97,95][i],now()));
 }
}
seed();

const sessions=new Map();
function auth(req,res,next){
 const token=req.headers.authorization?.replace('Bearer ','');
 const s=sessions.get(token);
 if(!s)return res.status(401).json({error:'Não autenticado'});
 const u=db.prepare('SELECT id,name,email,role,balance,status FROM users WHERE id=?').get(s.userId);
 if(!u||u.status!=='active')return res.status(403).json({error:'Conta indisponível'});
 req.user=u; next();
}
function admin(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'Acesso administrativo negado'});next()}

app.get('/api/health',(q,r)=>r.json({ok:true,mode:'SANDBOX',realMoney:false}));
app.post('/api/register',(req,res)=>{
 const {name,email,password}=req.body||{};
 if(!name||!email||!password||password.length<6)return res.status(400).json({error:'Preencha nome, e-mail e senha (mínimo 6 caracteres).'});
 try{
  const info=db.prepare('INSERT INTO users(name,email,password_hash,role,balance,created_at) VALUES(?,?,?,?,?,?)').run(name,email.toLowerCase(),hash(password),'player',10000,now());
  res.json({ok:true,userId:info.lastInsertRowid});
 }catch(e){res.status(400).json({error:'E-mail já cadastrado.'})}
});
app.post('/api/login',(req,res)=>{
 const {email,password}=req.body||{};
 const u=db.prepare('SELECT id,name,email,role,balance,status FROM users WHERE email=? AND password_hash=?').get((email||'').toLowerCase(),hash(password||''));
 if(!u||u.status!=='active')return res.status(401).json({error:'Login inválido'});
 const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{userId:u.id});
 res.json({token,user:u});
});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
app.get('/api/games',(req,res)=>res.json({games:db.prepare('SELECT * FROM games ORDER BY id').all()}));
app.get('/api/bets',auth,(req,res)=>res.json({bets:db.prepare('SELECT b.*,g.name game FROM bets b JOIN games g ON g.id=b.game_id WHERE b.user_id=? ORDER BY b.id DESC LIMIT 50').all(req.user.id)}));
app.post('/api/spin',auth,(req,res)=>{
 const bet=Math.floor(Number(req.body.bet)); const game=db.prepare('SELECT * FROM games WHERE id=? AND status="active"').get(req.body.gameId);
 if(!game)return res.status(400).json({error:'Jogo indisponível'});
 if(!Number.isFinite(bet)||bet<10)return res.status(400).json({error:'Aposta mínima: 10 créditos demo'});
 if(bet>req.user.balance)return res.status(400).json({error:'Saldo insuficiente'});
 const syms=['🍒','🍋','🍉','⭐','💎','7️⃣']; const reels=[0,1,2].map(()=>syms[Math.floor(Math.random()*syms.length)]);
 let mult=(reels[0]===reels[1]&&reels[1]===reels[2])?10:((reels[0]===reels[1]||reels[1]===reels[2]||reels[0]===reels[2])?2:0);
 const prize=bet*mult;
 const tx=db.transaction(()=>{
  db.prepare('UPDATE users SET balance=balance-?+? WHERE id=?').run(bet,prize,req.user.id);
  db.prepare('INSERT INTO bets(user_id,game_id,bet,prize,reels,multiplier,created_at) VALUES(?,?,?,?,?,?,?)').run(req.user.id,game.id,bet,prize,JSON.stringify(reels),mult,now());
  db.prepare('INSERT INTO transactions(user_id,type,amount,description,created_at) VALUES(?,?,?,?,?)').run(req.user.id,'bet',-bet,game.name,now());
  if(prize)db.prepare('INSERT INTO transactions(user_id,type,amount,description,created_at) VALUES(?,?,?,?,?)').run(req.user.id,'prize',prize,game.name,now());
 }); tx();
 const u=db.prepare('SELECT id,name,email,role,balance,status FROM users WHERE id=?').get(req.user.id);
 res.json({user:u,reels,prize,multiplier:mult});
});
app.post('/api/demo/bonus',auth,(req,res)=>{
 db.prepare('UPDATE users SET balance=balance+2500 WHERE id=?').run(req.user.id);
 db.prepare('INSERT INTO transactions(user_id,type,amount,description,created_at) VALUES(?,?,?,?,?)').run(req.user.id,'bonus',2500,'Bônus demo',now());
 res.json({user:db.prepare('SELECT id,name,email,role,balance,status FROM users WHERE id=?').get(req.user.id)});
});

/* ADMIN */
app.get('/api/admin/stats',auth,admin,(req,res)=>{
 const users=db.prepare('SELECT COUNT(*) n FROM users').get().n;
 const bets=db.prepare('SELECT COUNT(*) n FROM bets').get().n;
 const wager=db.prepare('SELECT COALESCE(SUM(bet),0) n FROM bets').get().n;
 const prizes=db.prepare('SELECT COALESCE(SUM(prize),0) n FROM bets').get().n;
 res.json({users,bets,wager,prizes});
});
app.get('/api/admin/users',auth,admin,(req,res)=>res.json({users:db.prepare('SELECT id,name,email,role,balance,status,created_at FROM users ORDER BY id DESC').all()}));
app.patch('/api/admin/users/:id',auth,admin,(req,res)=>{
 const {status}=req.body;if(!['active','blocked'].includes(status))return res.status(400).json({error:'Status inválido'});
 db.prepare('UPDATE users SET status=? WHERE id=?').run(status,req.params.id);res.json({ok:true});
});
app.get('/api/admin/bets',auth,admin,(req,res)=>res.json({bets:db.prepare('SELECT b.id,u.name user,g.name game,b.bet,b.prize,b.multiplier,b.created_at FROM bets b JOIN users u ON u.id=b.user_id JOIN games g ON g.id=b.game_id ORDER BY b.id DESC LIMIT 200').all()}));
app.get('/api/admin/games',auth,admin,(req,res)=>res.json({games:db.prepare('SELECT * FROM games ORDER BY id').all()}));
app.patch('/api/admin/games/:id',auth,admin,(req,res)=>{
 const {status}=req.body;if(!['active','paused'].includes(status))return res.status(400).json({error:'Status inválido'});
 db.prepare('UPDATE games SET status=? WHERE id=?').run(status,req.params.id);res.json({ok:true});
});
app.get('/api/admin/transactions',auth,admin,(req,res)=>res.json({transactions:db.prepare('SELECT t.*,u.name user FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 200').all()}));

const PORT=process.env.PORT||3000;
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));
app.listen(PORT,()=>console.log(`NEON SPINS online na porta ${PORT}`));
