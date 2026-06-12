// ai.js — IA v10: OppPredictor (Markov ordem-3), ContextBandit (Thompson), yomi, classe AI
// ═══════════════════════════════════════════════════════════════
//  v10 · CAMADA DE APRENDIZADO E PREDIÇÃO
//  1) OppPredictor — Markov de ordem 2 sobre "gestos" do oponente
//     (técnica de ghost-AI: prevê o próximo movimento e age antes)
//  2) ContextBandit — UCB1 contextual: aprende qual PLANO rende
//     mais dano líquido em cada contexto (zona × gesto do oponente)
//  3) AIMem — persistência em localStorage (GitHub Pages):
//     o aprendizado sobrevive entre sessões, por dupla de chars
// ═══════════════════════════════════════════════════════════════
function gestureToken(o){
  // Discretiza o estado do oponente num "gesto" observável
  if(o.state==='KO')return'KO';
  if(o.state==='HIT'||o.state==='HIT_AIR')return'HIT';
  if(o.state==='TAUNT')return'TAUNT';
  if(o.state==='GUARD')return'GUARD';
  if(o.state==='ATTACK')return (o.actId>=1000)?'SPC':'ATK';
  if(o.inAir||o.state==='JUMP')return'JUMP';
  if(o.state==='RUN_F')return'RUNF';
  if(o.state==='RUN_B')return'RUNB';
  if(o.state==='WALK_F')return'FWD';
  if(o.state==='WALK_B')return'BACK';
  if(o.state==='CROUCH')return'CR';
  return'IDLE';
}
class OppPredictor{
  // v10: ordem 3 — mistura PPM (0.50/0.32/0.18) entre contextos de
  // 3, 2 e 1 gestos. Contextos longos dominam quando têm amostra.
  constructor(){
    this.t1=new Map();      // tok         -> Map(next->count)  ordem 1
    this.t2=new Map();      // "a>b"       -> Map(next->count)  ordem 2
    this.t3=new Map();      // "a>b>c"     -> Map(next->count)  ordem 3
    this.last=null;this.prev=null;this.prev2=null;
    this.total=0;
  }
  _bump(map,key,nxt){
    let m=map.get(key);if(!m){m=new Map();map.set(key,m);}
    m.set(nxt,(m.get(nxt)||0)+1);
  }
  // Chamar apenas em MUDANÇA de gesto (evento), não por tick
  observe(tok){
    if(tok===this.last)return;
    if(this.last!=null){
      this._bump(this.t1,this.last,tok);
      if(this.prev!=null)this._bump(this.t2,this.prev+'>'+this.last,tok);
      if(this.prev2!=null&&this.prev!=null)this._bump(this.t3,this.prev2+'>'+this.prev+'>'+this.last,tok);
      this.total++;
    }
    this.prev2=this.prev;this.prev=this.last;this.last=tok;
  }
  // Probabilidade de o PRÓXIMO gesto ser `tok` (blend ordem2/ordem1)
  prob(tok){
    const read=(map,key)=>{
      const m=map.get(key);if(!m)return null;
      let n=0,c=0;for(const[k,v]of m){n+=v;if(k===tok)c=v;}
      return n>=3?{p:c/n,n}:null;
    };
    const o3=(this.prev2!=null&&this.prev!=null)?read(this.t3,this.prev2+'>'+this.prev+'>'+this.last):null;
    const o2=this.prev!=null?read(this.t2,this.prev+'>'+this.last):null;
    const o1=this.last!=null?read(this.t1,this.last):null;
    let p=0,w=0;
    if(o3){p+=o3.p*0.50;w+=0.50;}
    if(o2){p+=o2.p*0.32;w+=0.32;}
    if(o1){p+=o1.p*0.18;w+=0.18;}
    return w>0?p/w:0;
  }
  best(){
    const agg=new Map();
    const add=(m,w)=>{if(!m)return;let n=0;for(const v of m.values())n+=v;if(n<3)return;
      for(const[k,v]of m)agg.set(k,(agg.get(k)||0)+(v/n)*w);};
    if(this.prev2!=null&&this.prev!=null)add(this.t3.get(this.prev2+'>'+this.prev+'>'+this.last),0.50);
    if(this.prev!=null)add(this.t2.get(this.prev+'>'+this.last),0.32);
    if(this.last!=null)add(this.t1.get(this.last),0.18);
    let bk=null,bp=0;for(const[k,v]of agg)if(v>bp){bp=v;bk=k;}
    return bk?{tok:bk,p:bp}:null;
  }
  decay(f=0.85){
    for(const m of[this.t1,this.t2,this.t3])for(const[k,mm]of m){
      for(const[t,v]of mm){const nv=v*f;if(nv<0.25)mm.delete(t);else mm.set(t,nv);}
      if(!mm.size)m.delete(k);
    }
  }
  serialize(){
    const dump=m=>[...m].map(([k,mm])=>[k,[...mm]]);
    return{t1:dump(this.t1),t2:dump(this.t2),t3:dump(this.t3),total:this.total,last:this.last,prev:this.prev,prev2:this.prev2};
  }
  load(d){
    if(!d)return;
    const rd=a=>new Map((a||[]).map(([k,mm])=>[k,new Map(mm)]));
    this.t1=rd(d.t1);this.t2=rd(d.t2);this.t3=rd(d.t3);this.total=d.total||0;this.last=d.last??null;this.prev=d.prev??null;this.prev2=d.prev2??null;
  }
}
// UCB1 contextual: arms = planos táticos; contexto = zona × gesto opp
const BANDIT_PLANS=['RUSH','ZONE','PRESSURE','GROUND_GAME','COUNTER_POKE','NEUTRAL'];
class ContextBandit{
  constructor(){this.ctx=new Map();} // key -> {n, arms:{plan:{n,sum}}}
  _get(key){
    let c=this.ctx.get(key);
    if(!c){c={n:0,arms:{}};for(const p of BANDIT_PLANS)c.arms[p]={n:0,sum:0,sq:0};this.ctx.set(key,c);}
    return c;
  }
  // v10: THOMPSON SAMPLING gaussiano — amostra do posterior da recompensa
  // de cada plano (Normal com média e variância empíricas). Em ambiente
  // não-estacionário (oponente que também aprende) explora melhor que UCB1.
  static _randn(){ // Box-Muller
    let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  }
  pick(key,priors={},banned=new Set()){
    const c=this._get(key);
    let best=null,bs=-1e9;
    for(const p of BANDIT_PLANS){
      if(banned.has(p))continue;
      const a=c.arms[p];
      const n=a.n||0;
      const mean=n>0.5?a.sum/n:0.40;             // otimismo inicial moderado
      let sd=0.65;                               // prior de desvio
      if(n>1.5){
        const varE=Math.max(0.02,a.sq/n-mean*mean);
        sd=Math.sqrt(varE);
      }
      const sample=mean+ContextBandit._randn()*sd/Math.sqrt(n+1);
      const s=sample+(priors[p]||0);
      if(s>bs){bs=s;best=p;}
    }
    return best||'NEUTRAL';
  }
  reward(key,plan,r){
    const c=this._get(key);const a=c.arms[plan];if(!a)return;
    r=Math.max(-1.5,Math.min(1.5,r));
    c.n++;a.n++;a.sum+=r;a.sq=(a.sq||0)+r*r;
  }
  decay(f=0.90){
    for(const c of this.ctx.values()){c.n*=f;for(const p in c.arms){const a=c.arms[p];a.n*=f;a.sum*=f;a.sq=(a.sq||0)*f;}}
  }
  serialize(){return[...this.ctx].map(([k,c])=>[k,c.n,BANDIT_PLANS.map(p=>[c.arms[p].n,c.arms[p].sum,c.arms[p].sq||0])]);}
  load(d){
    if(!Array.isArray(d))return;
    this.ctx=new Map();
    for(const[k,n,arms]of d){
      const c={n,arms:{}};
      BANDIT_PLANS.forEach((p,i)=>{c.arms[p]={n:arms?.[i]?.[0]||0,sum:arms?.[i]?.[1]||0,sq:arms?.[i]?.[2]||0};});
      this.ctx.set(k,c);
    }
  }
}
// ═══════════════════════════════════════════════════════════════
//  v13 · REDE NEURAL — bandit contextual neural para escolha de plano
//  Problema visto nas planilhas: a tabela zona×gesto fragmenta as
//  amostras (n máx ~10 após milhares de rounds). Um MLP pequeno
//  (26→20→6, ~660 parâmetros) aprende Q(s,plano) sobre FEATURES
//  CONTÍNUAS (hp, barra, distância, gesto previsto, powerGap...),
//  generalizando entre situações parecidas. Treino online por SGD
//  (regressão do retorno do episódio — contextual bandit neural,
//  sem bootstrap → estável). Custo: 1 forward+backward por episódio.
// ═══════════════════════════════════════════════════════════════
class TinyMLP{
  constructor(nin,nh,nout){
    this.nin=nin;this.nh=nh;this.nout=nout;
    const he=n=>Math.sqrt(2/n);
    this.w1=new Float32Array(nin*nh);this.b1=new Float32Array(nh);
    this.w2=new Float32Array(nh*nout);this.b2=new Float32Array(nout);
    for(let i=0;i<this.w1.length;i++)this.w1[i]=(Math.random()*2-1)*he(nin);
    for(let i=0;i<this.w2.length;i++)this.w2[i]=(Math.random()*2-1)*he(nh);
    this._h=new Float32Array(nh);this._q=new Float32Array(nout);
    this.steps=0;this.lossEwma=0;
  }
  forward(x){
    const{nin,nh,nout,w1,b1,w2,b2,_h,_q}=this;
    for(let j=0;j<nh;j++){
      let s=b1[j];const off=j*nin;
      for(let i=0;i<nin;i++)s+=w1[off+i]*x[i];
      _h[j]=s>0?s:0;                          // ReLU
    }
    for(let k=0;k<nout;k++){
      let s=b2[k];const off=k*nh;
      for(let j=0;j<nh;j++)s+=w2[off+j]*_h[j];
      _q[k]=s;
    }
    return _q;
  }
  // regressão só na cabeça da ação escolhida (alvo = retorno do episódio)
  train(x,action,target,lr=0.012){
    const q=this.forward(x);
    let err=q[action]-target;
    err=Math.max(-1.5,Math.min(1.5,err));     // clip de gradiente
    this.lossEwma=this.lossEwma*0.98+err*err*0.02;
    const{nin,nh,w1,b1,w2,b2,_h}=this;
    const off2=action*nh;
    for(let j=0;j<nh;j++){
      const gh=err*w2[off2+j]*(_h[j]>0?1:0);  // grad pré-ReLU
      w2[off2+j]-=lr*err*_h[j];
      if(gh!==0){
        const off1=j*nin;
        for(let i=0;i<nin;i++)w1[off1+i]-=lr*gh*x[i];
        b1[j]-=lr*gh;
      }
    }
    b2[action]-=lr*err;
    this.steps++;
  }
  serialize(){return{nin:this.nin,nh:this.nh,nout:this.nout,steps:this.steps,
    w1:Array.from(this.w1),b1:Array.from(this.b1),
    w2:Array.from(this.w2),b2:Array.from(this.b2)};}
  load(d){
    if(!d||d.nin!==this.nin||d.nh!==this.nh||d.nout!==this.nout)return;
    this.w1.set(d.w1);this.b1.set(d.b1);this.w2.set(d.w2);this.b2.set(d.b2);
    this.steps=d.steps||0;
  }
}
const NN_TOKS=['ATK','SPC','GUARD','JUMP','FWD','BACK','CR'];
const NN_ZONES=['CLOSE','MID','MID_FAR','FAR','FULL'];
class NeuralPlanner{
  constructor(){this.net=new TinyMLP(26,20,BANDIT_PLANS.length);}
  // vetor de estado contínuo — 26 features normalizadas
  features(ai,dist){
    const x=new Float32Array(26);let i=0;
    const f=ai.f,o=ai.opp,mm=ai.matchup;
    x[i++]=f.hp/Math.max(1,f.maxHp);
    x[i++]=o.hp/Math.max(1,o.maxHp);
    x[i++]=(f.hp/Math.max(1,f.maxHp))-(o.hp/Math.max(1,o.maxHp));
    x[i++]=Math.min(1,(f.meter||0)/300);
    x[i++]=Math.min(1,(o.meter||0)/300);
    x[i++]=Math.min(1,dist/600);
    const z=ai._zone(dist);
    for(const zn of NN_ZONES)x[i++]=z===zn?1:0;
    const tok=ai._lastOppTok;
    for(const t of NN_TOKS)x[i++]=tok===t?1:0;
    x[i++]=NN_TOKS.includes(tok)?0:1;          // "outro"
    const ph=ai._predHint;
    x[i++]=ph?ph.p:0;
    x[i++]=ph&&(ph.tok==='ATK'||ph.tok==='SPC')?1:0;
    x[i++]=ph&&ph.tok==='JUMP'?1:0;
    x[i++]=ph&&ph.tok==='GUARD'?1:0;
    x[i++]=mm?mm.wr:0.5;
    x[i++]=mm?Math.min(2,mm.powerGap())/2:0.5;
    x[i++]=mm?Math.min(1,mm.lossStreak/10):0;
    return x;
  }
  q(x){return this.net.forward(x);}
  learn(x,planIdx,reward){this.net.train(x,planIdx,Math.max(-2,Math.min(2,reward)));}
  serialize(){return this.net.serialize();}
  load(d){this.net.load(d);}
}
// ═══════════════════════════════════════════════════════════════
//  v12 · MODELO DE CONFRONTO (MATCHUP) — vencer quem é mais forte
//  Diagnóstico das planilhas: o perdedor ficava com winrate FLAT
//  (Zero ~0% por 1100 rounds) e quase não bloqueava. Esta camada:
//  · mede força relativa (dps próprio × dps do rival, EWMA)
//  · classifica o confronto: DOMINANT / EVEN / UNDERDOG / CRUSHED
//  · em desvantagem, faz BUSCA DE PORTFÓLIO: testa contra-estilos
//    discretos em blocos de rounds e aprende qual vence (Thompson)
//  · "rubber-band" legítimo: derrotas seguidas afiam reação/confirm
//  · tudo persiste por dupla de personagens (localStorage)
// ═══════════════════════════════════════════════════════════════
const COUNTER_STYLES={
  // knobs: agg/pat/risk substituem P.*; demais alimentam decisões táticas
  BASE        :{agg:null,pat:null,risk:null,guardBoost:0.00,engageDelay:0, jumpBias:0.00,projBias:0.0,pokeOnly:false,allIn:false},
  TURTLE_PUNISH:{agg:0.22,pat:0.90,risk:0.25,guardBoost:0.34,engageDelay:55,jumpBias:0.02,projBias:0.1,pokeOnly:true ,allIn:false},
  HIT_AND_RUN :{agg:0.55,pat:0.62,risk:0.40,guardBoost:0.18,engageDelay:25,jumpBias:0.10,projBias:0.1,pokeOnly:true ,allIn:false},
  ZONE_KEEPOUT:{agg:0.30,pat:0.80,risk:0.30,guardBoost:0.22,engageDelay:40,jumpBias:0.04,projBias:0.6,pokeOnly:false,allIn:false},
  AIR_ASSAULT :{agg:0.72,pat:0.35,risk:0.60,guardBoost:0.10,engageDelay:10,jumpBias:0.45,projBias:0.0,pokeOnly:false,allIn:false},
  ALL_IN_BURST:{agg:0.95,pat:0.10,risk:0.95,guardBoost:0.05,engageDelay:0, jumpBias:0.12,projBias:0.0,pokeOnly:false,allIn:true },
};
const STYLE_NAMES=Object.keys(COUNTER_STYLES);
class MatchupModel{
  constructor(){
    this.wr=0.5;              // winrate EWMA
    this.dpsMe=1;this.dpsOpp=1; // dano/seg EWMA
    this.lossStreak=0;this.rounds=0;
    this.style='BASE';this.styleLeft=0;this._styleWins=0;this._styleDmgR=0;this._styleRounds=0;
    this.styleStats={};for(const s of STYLE_NAMES)this.styleStats[s]={n:0,sum:0,sq:0};
    this._rndDealt=0;this._rndTaken=0;this._rndT0=0;
  }
  mode(){
    if(this.rounds<4)return'EVEN';
    if(this.wr<0.22)return'CRUSHED';
    if(this.wr<0.40)return'UNDERDOG';
    if(this.wr>0.62)return'DOMINANT';
    return'EVEN';
  }
  powerGap(){return this.dpsOpp/Math.max(0.05,this.dpsMe);}      // >1 = rival bate mais forte
  caution(){const m=this.mode();return this.powerGap()>1.30&&(m==='UNDERDOG'||m==='CRUSHED');}
  skipRush(){const m=this.mode();return m==='CRUSHED'||(m==='UNDERDOG'&&this.powerGap()>1.25);}
  guardBoost(){const m=this.mode();return m==='CRUSHED'?0.30:m==='UNDERDOG'?0.18:0;}
  knobs(){
    if(this.style==='CUSTOM'&&this.spsa?.on)return this._spsaKnobs(); // v13
    return COUNTER_STYLES[this.style]||COUNTER_STYLES.BASE;
  }
  // chamada a cada hit (do game loop)
  noteDamage(dealt,taken){this._rndDealt+=dealt;this._rndTaken+=taken;}
  // Thompson sobre estilos — recompensa = winrate do bloco + razão de dano
  _pickStyle(){
    let best='TURTLE_PUNISH',bs=-1e9;
    for(const s of STYLE_NAMES){
      if(s==='BASE')continue;
      const a=this.styleStats[s];
      const n=a.n||0,mean=n>0.5?a.sum/n:0.45;
      let sd=0.55;
      if(n>1.5)sd=Math.sqrt(Math.max(0.02,a.sq/n-mean*mean));
      const sample=mean+ContextBandit._randn()*sd/Math.sqrt(n+1);
      if(sample>bs){bs=sample;best=s;}
    }
    return best;
  }
  _closeStyleBlock(){
    if(this.style==='BASE'||this._styleRounds<=0)return;
    const a=this.styleStats[this.style];
    const r=Math.max(-1,Math.min(1.5,
      (this._styleWins/this._styleRounds)*1.2+(this._styleDmgR/this._styleRounds)*0.5-0.35));
    a.n++;a.sum+=r;a.sq+=r*r;
    this._styleWins=0;this._styleDmgR=0;this._styleRounds=0;
  }
  roundEnd(won,durTicks){
    this.rounds++;
    this.wr=this.wr*0.94+(won?1:0)*0.06;
    const sec=Math.max(0.5,durTicks/60);
    this.dpsMe =this.dpsMe *0.85+(this._rndDealt/sec)*0.15;
    this.dpsOpp=this.dpsOpp*0.85+(this._rndTaken/sec)*0.15;
    const dmgRatio=this._rndDealt/Math.max(1,this._rndDealt+this._rndTaken);
    this.lossStreak=won?0:this.lossStreak+1;
    if(this.style==='CUSTOM'){
      // v13: blocos curtos (4 rounds) avaliando θ+cΔ e θ−cΔ
      this._styleRounds++;this._styleWins+=won?1:0;this._styleDmgR+=dmgRatio;
      this.styleLeft--;
      if(this.styleLeft<=0){
        const J=(this._styleWins/Math.max(1,this._styleRounds))*1.2
               +(this._styleDmgR/Math.max(1,this._styleRounds))*0.5;
        this._spsaBlockEnd(J);
        this._styleWins=0;this._styleDmgR=0;this._styleRounds=0;
        this.styleLeft=4;
        if(this.mode()==='DOMINANT'){this.style='BASE';}      // virou o jogo
      }
    }else if(this.style!=='BASE'){
      this._styleRounds++;this._styleWins+=won?1:0;this._styleDmgR+=dmgRatio;
      this.styleLeft--;
      if(this.styleLeft<=0){
        this._closeStyleBlock();
        const m=this.mode();
        if((m==='UNDERDOG'||m==='CRUSHED')&&this._portfolioStuck()){
          if(!this.spsa)this._spsaInit();                     // v13
          this.style='CUSTOM';this.styleLeft=4;
        }
        else if(m==='UNDERDOG'||m==='CRUSHED'){this.style=this._pickStyle();this.styleLeft=8;}
        else if(m==='DOMINANT'){this.style='BASE';}   // virou o jogo de vez
        else{
          // EVEN: se um contra-estilo está comprovadamente vencendo,
          // NÃO descartar — é ele que está segurando o confronto
          const a=this.styleStats[this.style];
          const mean=a&&a.n>0.5?a.sum/a.n:-1;
          let bestS=null,bestM=0.15;
          for(const s in this.styleStats){const st=this.styleStats[s];
            if(st.n>1&&st.sum/st.n>bestM){bestM=st.sum/st.n;bestS=s;}}
          if(mean>0.15){this.styleLeft=8;}            // mantém o atual
          else if(bestS){this.style=bestS;this.styleLeft=8;}
          else this.style='BASE';
        }
      }
    }else{
      const m=this.mode();
      if(m==='UNDERDOG'||m==='CRUSHED'){this.style=this._pickStyle();this.styleLeft=8;}
    }
    this._rndDealt=0;this._rndTaken=0;
  }
  // ═══ v13 · SPSA: otimização contínua dos knobs do estilo ═════════
  // Visto nas planilhas (Terry×Sinobu powerGap 8.6, Leona CRUSHED):
  // quando NENHUM estilo discreto tem recompensa >0.25, o portfólio
  // empaca. O SPSA perturba o vetor contínuo de knobs (±cΔ) em blocos
  // alternados, estima o gradiente com 2 avaliações e dá um passo —
  // encontra misturas que não existem no portfólio (ex.: guarda 0.55
  // + projétil 0.8 + engajamento tardio).
  _spsaInit(){
    this.spsa={
      on:true,
      th:[0.35,0.70,0.35,0.30,35,0.10,0.30],  // agg,pat,risk,guard,delay,jump,proj
      lo:[0.05,0.05,0.05,0.00, 0,0.00,0.00],
      hi:[1.00,1.00,1.00,0.60,70,0.60,1.00],
      c:[0.10,0.10,0.10,0.08, 9,0.08,0.12],   // amplitude da perturbação
      a:[0.12,0.12,0.12,0.10,11,0.10,0.15],   // passo
      delta:null,phase:0,Jp:0,Jm:0,iter:0,
    };
    this._spsaNewDelta();
  }
  _spsaNewDelta(){this.spsa.delta=this.spsa.th.map(()=>Math.random()<0.5?-1:1);}
  _spsaKnobs(){
    const s=this.spsa,sgn=s.phase===0?1:-1;
    const v=s.th.map((t,i)=>Math.max(s.lo[i],Math.min(s.hi[i],t+sgn*s.c[i]*s.delta[i])));
    return{agg:v[0],pat:v[1],risk:v[2],guardBoost:v[3],engageDelay:v[4]|0,
           jumpBias:v[5],projBias:v[6],pokeOnly:v[0]<0.40,allIn:v[0]>0.85};
  }
  _spsaBlockEnd(J){ // J = winrate+dmgRatio do bloco
    const s=this.spsa;
    if(s.phase===0){s.Jp=J;s.phase=1;return;}
    s.Jm=J;s.phase=0;s.iter++;
    const g=(s.Jp-s.Jm);
    for(let i=0;i<s.th.length;i++){
      s.th[i]+=s.a[i]*g*s.delta[i]/(2*1);     // Δ∈{±1} ⇒ 1/Δ = Δ
      s.th[i]=Math.max(s.lo[i],Math.min(s.hi[i],s.th[i]));
    }
    this._spsaNewDelta();
  }
  // ativa SPSA quando o portfólio está esgotado e seguimos esmagados
  _portfolioStuck(){
    let blocks=0,best=-9;
    for(const s in this.styleStats){const a=this.styleStats[s];
      blocks+=a.n;if(a.n>1)best=Math.max(best,a.sum/a.n);}
    return blocks>=22&&best<0.25;
  }
  // bônus de recompensa: vencer trocas contra rival mais forte vale mais
  rewardScale(){return 0.6+0.8*Math.min(2,this.powerGap());}
  serialize(){return{wr:this.wr,dpsMe:this.dpsMe,dpsOpp:this.dpsOpp,rounds:this.rounds,
    lossStreak:this.lossStreak,style:this.style,styleLeft:this.styleLeft,
    styleStats:this.styleStats,_sw:this._styleWins,_sd:this._styleDmgR,_sr:this._styleRounds,
    spsa:this.spsa?{on:this.spsa.on,th:this.spsa.th,phase:this.spsa.phase,
      delta:this.spsa.delta,Jp:this.spsa.Jp,iter:this.spsa.iter}:null};}
  load(d){if(!d)return;
    this.wr=d.wr??0.5;this.dpsMe=d.dpsMe??1;this.dpsOpp=d.dpsOpp??1;this.rounds=d.rounds||0;
    this.lossStreak=d.lossStreak||0;this.style=d.style||'BASE';this.styleLeft=d.styleLeft||0;
    if(d.styleStats)for(const s of STYLE_NAMES)if(d.styleStats[s])this.styleStats[s]=d.styleStats[s];
    this._styleWins=d._sw||0;this._styleDmgR=d._sd||0;this._styleRounds=d._sr||0;
    if(d.spsa){this._spsaInit();Object.assign(this.spsa,d.spsa);if(!this.spsa.delta)this._spsaNewDelta();}}
}
// Persistência (GitHub Pages) — falha silenciosamente se storage indisponível
const AIMem={
  _ok(){try{return typeof localStorage!=='undefined';}catch(e){return false;}},
  key(me,opp){return'kofai9:'+String(me).slice(0,16)+'|vs|'+String(opp).slice(0,16);},
  save(me,opp,data){
    if(!this._ok())return;
    try{localStorage.setItem(this.key(me,opp),JSON.stringify(data));}catch(e){}
  },
  load(me,opp){
    if(!this._ok())return null;
    try{const s=localStorage.getItem(this.key(me,opp));return s?JSON.parse(s):null;}catch(e){return null;}
  }
};

class AI{
  constructor(f,opp,winsRef){
    this.f=f;this.opp=opp;
    this.winsRef=winsRef;
    this.interval=9;
    this.tick=this.interval-1;
    this.queue=[];this.qCooldown=0;

    // ── Personality ──────────────────────────────────────────────
    this.P={
      aggression:0.35+Math.random()*0.55,
      patience  :0.30+Math.random()*0.50,
      riskTaking:0.20+Math.random()*0.60,
      adaptRate :0.40+Math.random()*0.45, // [C] magnitude de adaptação por round
    };

    // ── Strategy memory [C: agora LIDO em _updatePlan] ────────────
    this.stratBias={rushdown:0,zoning:0,grapple:0,aerial:0,counter:0};
    this.roundsWon=0;this.roundsLost=0;

    // ── Reconhecimento de padrão do oponente ─────────────────────
    this.oppPattern={jumpFreq:0,spamFreq:0,aggrFreq:0,guardFreq:0,hitTakenFreq:0,lastStates:[],sampleTick:0};

    // ── Rastreamento de performance de movimentos ─────────────────
    this.moveHits=new Map();
    this.moveWhiffs=new Map();
    this._lastPickedId=-1;
    this._streak=0;
    this.routeScores=new Map();   // combo route empirical damage tracking
    this.provenMoves=new Set();   // moves proven to connect in practice

    // ── Estado tático ─────────────────────────────────────────────
    this.plan='NEUTRAL';
    this.emotion={anger:0,confidence:0.10,frustration:0,showboat:0,fear:0.08,composure:0.62,tilt:0,dominance:0.12};
    this.passiveOppTicks=0;
    this.planTimer=0;
    this.stunCooldown=0;
    this.hitsTaken=0;
    this.jumpCooldown=0;
    this.spCooldown=0;
    this.hyCooldown=0;
    this.guardCooldown=0;
    this.crouchCooldown=0; // [D]
    this.lastAtkId=-1;
    this.lastAtkHit=false;
    this.punishWindow=0;
    this.punishVisTimer=0;

    // ── Heatmap [C: heatDef agora usado para fuga] ────────────────
    this.heatAtk=new Array(5).fill(0);
    this.heatDef=new Array(5).fill(0);
    this.preferredDist=180; // [C] consultado no posicionamento

    // ── Reactive layer [B] ────────────────────────────────────────
    this._reactCooldown=0;
    this._prevOppState=undefined;
    this._prevSelfState=undefined;
    this._stallTicks=0;
    this._lastX=f.x;
    this._lastDist=9999;
    this.roundStartRushTicks=0;
    this._forceEngageTicks=0; // BUG FIX: inicializar explicitamente (era undefined)
    this._lastLogReason='';
    this._lastLogTick=0;

    // ── v8: REACTION + RESOURCE MODEL ────────────────────────────
    // Per-AI "skill" knobs (variam por personagem → rivais sentem diferentes)
    this.reactionVar  =0.55+Math.random()*0.38; // nitidez de reação (anti-air, punish, cadência)
    this.confirmSkill =0.50+Math.random()*0.42; // capacidade de hit-confirm antes de gastar barra
    this._meterPlan='SPEND';   // BUILD | SPEND | SAVE_REVERSAL — economia de barra
    this._aaCooldown=0;        // cooldown dedicado de anti-aéreo reativo
    this._punishCooldown=0;    // cooldown dedicado de punish de whiff
    this._oppAirTicks=0;       // há quantos ticks o oponente está no ar (leitura de comprometimento)

    // ── v9: PREDIÇÃO + APRENDIZADO ───────────────────────────────
    this.predictor=new OppPredictor();   // Markov dos gestos do oponente
    this.bandit=new ContextBandit();     // UCB1: aprende plano por contexto
    this._lastOppTok='IDLE';
    this._predHint=null;                 // melhor previsão do tick
    this._predGuardCd=0;                 // cooldown da guarda preditiva
    this._planEpisode=null;              // episódio aberto p/ recompensa
    this._selfPlanHist=[];               // yomi: meus próprios planos
    // v13: rede neural de planejamento (bandit contextual neural)
    this.planner=new NeuralPlanner();
    // v12: modelo de confronto + estilo de contra-jogo ativo
    this.matchup=new MatchupModel();
    this.styleK=COUNTER_STYLES.BASE;
    this._baseReaction=this.reactionVar;this._baseConfirm=this.confirmSkill;
    // Carrega aprendizado persistido entre sessões (GitHub Pages)
    try{
      const saved=AIMem.load(this.f.char?.name||'me',this.opp.char?.name||'op');
      if(saved){
        this.predictor.load(saved.pred);
        this.bandit.load(saved.bandit);
        if(saved.matchup)this.matchup.load(saved.matchup);
        if(saved.planner)this.planner.load(saved.planner); // v13
      }
    }catch(e){}
    this._applyStyle();

    this._classifyMoves();
    // [A] Cache de ranges — calculados uma vez, nunca mudam
    this._hitRv=this._hitR();
    this._spRv =this._spR();
    this._hyRv =this._hyR();
  }

  _classifyMoves(){
    const mm=this.f.char.moveMap,meta=mm.meta||{};
    const usable=arr=>[...new Set(arr)].filter(id=>meta[id]?.usable!==false);
    const byId=arr=>usable(arr).sort((a,b)=>a-b);
    const moveScore=id=>{
      const m=meta[id]||{};
      let s=(m.score||0)+(m.hasHitDef?3:0)+Math.min(5,(m.realDamage||0)/18)+(m.multiCount>1?0.8:0)+(m.hasClsn1?0.5:0);
      if(id>=1000)s+=0.4;
      return s;
    };
    const byScore=arr=>usable(arr).sort((a,b)=>moveScore(b)-moveScore(a)||a-b);

    // FIX #1: li/mi/he devem representar RÁPIDO/MÉDIO/PESADO por duração/score,
    // não os primeiros/segundos/terceiros IDs numericamente.
    // "li" = normals mais rápidos (menor dur) → melhores starters/pokes
    // "mi" = normals médios (dur média)
    // "he" = normals pesados (maior dur, maior dano) → melhores enders
    const normalsByScore=byScore(mm.atkStand);
    const normalsByDur=[...usable(mm.atkStand)].sort((a,b)=>{
      const da=(meta[a]?.dur||99),db=(meta[b]?.dur||99);
      return da-db||(moveScore(b)-moveScore(a));
    });
    const t=Math.max(1,Math.ceil(normalsByDur.length/3));
    this.li=normalsByDur.slice(0,t);        // mais rápidos → pokes/starters
    if(!this.li.length)this.li=normalsByScore.slice(0,4);
    this.mi=normalsByDur.slice(t,t*2);      // médios → links
    if(!this.mi.length)this.mi=normalsByScore.slice(1,5);
    this.he=normalsByDur.slice(t*2);        // pesados → enders
    if(!this.he.length)this.he=byScore(mm.signatures?.enders?.length?mm.signatures.enders:mm.atkStand).slice(0,4);
    this.bestNormal=byScore(this.li.length?this.li:normalsByScore)[0]||normalsByScore[0]||null;
    this.crouchAtks=byScore(mm.atkCrouch);
    this.airAtks=byScore(mm.atkAir);
    this.signatureSpecials=byScore(mm.signatures?.specials?.length?mm.signatures.specials:mm.specials);
    this.signatureHypers=byScore(mm.signatures?.hypers?.length?mm.signatures.hypers:mm.hypers);
    this.antiAirMoves=byScore(mm.signatures?.antiAir?.length?mm.signatures.antiAir:[...mm.atkStand,...mm.atkAir,...mm.specials]);
    this.projectileMoves=byScore(mm.signatures?.projectiles?.length?mm.signatures.projectiles:mm.specials.filter(id=>mm.meta?.[id]?.isProjectile));
    this.rushMoves=byScore(mm.signatures?.rush?.length?mm.signatures.rush:[...mm.specials,...mm.runF]);
    this.tauntMoves=byScore(mm.signatures?.taunts?.length?mm.signatures.taunts:mm.taunts);
    this.comboStarters=byScore(mm.signatures?.starters?.length?mm.signatures.starters:[...mm.atkStand,...mm.atkCrouch]).slice(0,6);
    this.comboEnders=byScore(mm.signatures?.enders?.length?mm.signatures.enders:[...mm.specials,...mm.hypers,...mm.atkStand]).slice(0,8);
    this.routes=(mm.routes||[]).filter(r=>r.every(id=>meta[id]?.usable!==false&&(meta[id]?.hasHitDef||meta[id]?.hasClsn1||(meta[id]?.fromCommand==='special')||(meta[id]?.fromCommand==='hyper')))).sort((a,b)=>{
      const sa=a.reduce((n,id)=>n+moveScore(id),0), sb=b.reduce((n,id)=>n+moveScore(id),0);
      return sb-sa||b.length-a.length;
    });
  }

  // [A] Zone enum — fonte única de verdade para distância
  _zone(dist){
    if(dist>this._spRv*1.6) return'FAR';
    if(dist>this._spRv)     return'MID_FAR';
    if(dist>this._hitRv)    return'MID';
    if(dist>this._hitRv*0.55)return'CLOSE';
    return'GRAB';
  }

  // Ranges (cache em constructor via _hitRv/_spRv/_hyRv)
  _hitR(){const p=this.f._prof,sc=this.f.scale;return Math.max(38,p.charW*0.82*sc)+Math.max(36,p.charW*0.55*sc)/2-6;}
  _spR() {const p=this.f._prof,sc=this.f.scale;return(Math.max(38,p.charW*0.82*sc)*1.45+12)+Math.max(36,p.charW*0.55*sc)/2-6;}
  _hyR() {const p=this.f._prof,sc=this.f.scale;return(Math.max(38,p.charW*0.82*sc)*1.9+20)+Math.max(36,p.charW*0.55*sc)/2-6;}

  // ── Persistent memory extract/inject for cross-round learning ───
  _extractMemory(){
    return{
      P:{...this.P},
      stratBias:{...this.stratBias},
      moveHits:new Map(this.moveHits),
      moveWhiffs:new Map(this.moveWhiffs),
      heatAtk:[...this.heatAtk],
      heatDef:[...this.heatDef],
      preferredDist:this.preferredDist,
      roundsWon:this.roundsWon,
      roundsLost:this.roundsLost,
      _streak:this._streak,
      emotion:{...this.emotion},
      oppPattern:{
        jumpFreq:this.oppPattern.jumpFreq,
        spamFreq:this.oppPattern.spamFreq,
        aggrFreq:this.oppPattern.aggrFreq,
        guardFreq:this.oppPattern.guardFreq,
        hitTakenFreq:this.oppPattern.hitTakenFreq,
      },
      // Combo route performance — track damage actually dealt per route
      routeScores:this.routeScores?new Map(this.routeScores):new Map(),
      // Best moves proven in practice
      provenMoves:this.provenMoves?new Set(this.provenMoves):new Set(),
      // v8: traços de "skill" persistem entre rounds (mantém o caráter do lutador)
      reactionVar:this.reactionVar,
      confirmSkill:this.confirmSkill,
      // v9: predição + bandit sobrevivem entre rounds
      predMem:this.predictor.serialize(),
      banditMem:this.bandit.serialize(),
      matchupMem:this.matchup?.serialize(), // v12
      plannerMem:this.planner?.serialize(), // v13
    };
  }
  _injectMemory(mem){
    if(!mem)return;
    this.P={...mem.P};
    this.stratBias={...mem.stratBias};
    this.moveHits=new Map(mem.moveHits);
    this.moveWhiffs=new Map(mem.moveWhiffs);
    this.heatAtk=[...mem.heatAtk];
    this.heatDef=[...mem.heatDef];
    this.preferredDist=mem.preferredDist;
    this.roundsWon=mem.roundsWon;
    this.roundsLost=mem.roundsLost;
    this._streak=mem._streak;
    this.emotion={...mem.emotion};
    this.oppPattern.jumpFreq=mem.oppPattern.jumpFreq;
    this.oppPattern.spamFreq=mem.oppPattern.spamFreq;
    this.oppPattern.aggrFreq=mem.oppPattern.aggrFreq;
    this.oppPattern.guardFreq=mem.oppPattern.guardFreq;
    this.oppPattern.hitTakenFreq=mem.oppPattern.hitTakenFreq;
    this.routeScores=new Map(mem.routeScores);
    this.provenMoves=new Set(mem.provenMoves);
    if(typeof mem.reactionVar==='number')this.reactionVar=mem.reactionVar;   // v8
    if(typeof mem.confirmSkill==='number')this.confirmSkill=mem.confirmSkill; // v8
    if(mem.predMem)this.predictor.load(mem.predMem);   // v9
    if(mem.banditMem)this.bandit.load(mem.banditMem);  // v9
    if(mem.matchupMem){this.matchup.load(mem.matchupMem);this._applyStyle();} // v12
    if(mem.plannerMem)this.planner.load(mem.plannerMem); // v13
    // Re-sort routes using accumulated performance data
    this._reweightRoutes();
    // BUG FIX: reclassificar pools após injeção para que provenMoves influencie bestNormal e tiers
    this._classifyMoves();
  }

  // Re-sort combo routes using empirical hit/whiff data
  _reweightRoutes(){
    const mm=this.f.char.moveMap;
    if(!mm.routes?.length)return;
    this.routes=[...mm.routes].sort((a,b)=>{
      const scoreRoute=seq=>{
        let s=0;
        for(const id of seq){
          const h=this.moveHits.get(id)||0;
          const w=this.moveWhiffs.get(id)||0;
          const total=h+w;
          s+=total>0?(h/total)*10:1;
          s+=(mm.meta?.[id]?.realDamage||0)*0.04;
          if(this.provenMoves?.has(id))s+=5;
        }
        const rs=this.routeScores?.get(seq.join('>'))||0;
        return s+rs;
      };
      return scoreRoute(b)-scoreRoute(a)||b.length-a.length;
    });
  }

  notifyAtkHit(id,x){
    this.emotion.confidence=Math.min(1,this.emotion.confidence+0.10);
    this.emotion.frustration=Math.max(0,this.emotion.frustration-0.06);
    this.emotion.composure=Math.min(1,this.emotion.composure+0.04);
    this.emotion.fear=Math.max(0,this.emotion.fear-0.03);
    this.emotion.dominance=Math.min(1,this.emotion.dominance+0.05);
    this.emotion.tilt=Math.max(0,this.emotion.tilt-0.04);
    this.moveHits.set(id,(this.moveHits.get(id)||0)+1);
    // Mark as proven move once it hits 2+ times
    if((this.moveHits.get(id)||0)>=2)this.provenMoves?.add(id);
    this.lastAtkHit=true;
    if(x!==undefined){const z=Math.min(4,Math.floor(x/CW*5));this.heatAtk[z]++;}
    const totalHits=[...this.moveHits.values()].reduce((a,b)=>a+b,0);
    if(totalHits%3===0)this._recomputePreferredDist();
    // FIX: reclassificar pools a cada 6 hits para que provenMoves influencie seleção
    if(totalHits%6===0)this._classifyMoves();
  }
  notifyComboRoute(seq,dmg){
    if(!this.routeScores)this.routeScores=new Map();
    const key=seq.join('>');
    this.routeScores.set(key,(this.routeScores.get(key)||0)+dmg*0.1);
  }
  notifyHitReceived(x){
    if(x!==undefined){const z=Math.min(4,Math.floor(x/CW*5));this.heatDef[z]++;}
  }
  _recomputePreferredDist(){
    const best=this.heatAtk.indexOf(Math.max(...this.heatAtk));
    const hitR=this._hitRv,spR=this._spRv;
    const zoneDist=[spR*1.2,spR*0.85,hitR*1.1,spR*0.85,spR*1.2];
    this.preferredDist=zoneDist[best];
  }
  _safeLead(){return (this.winsRef?.me||0)-(this.winsRef?.them||0);}
  _isSafeToShowboat(dist){
    const f=this.f,o=this.opp;
    const hpLead=(f.hp/f.maxHp)-(o.hp/o.maxHp);
    const calmOpp=!o.isAtk&&!o.inAir&&(o.state==='STAND'||o.state==='CROUCH'||o.state==='WALK_F'||o.state==='WALK_B');
    return !f.inAir&&!f.isAtk&&f.state!=='GUARD'&&f.state!=='HIT'&&f.state!=='HIT_AIR'&&
           dist>this._hitRv*1.05&&dist<this._spRv*1.95&&f.hp/f.maxHp>0.34&&
           (hpLead>0.08||this._safeLead()>=1||this.emotion.dominance>0.45)&&
           calmOpp&&this.emotion.composure>0.40&&this.emotion.fear<0.45;
  }
  _canTaunt(dist){
    return !!(this.tauntMoves?.length&&this._isSafeToShowboat(dist)&&this.emotion.confidence>0.36&&
      (this.emotion.showboat>0.18||this.emotion.dominance>0.26||this._safeLead()>=1)&&Math.random()<0.11);
  }
  _pickEmoteId(){
    const mm=this.f.char.moveMap||{};
    const taunts=this._usableList(this.tauntMoves?.length?this.tauntMoves:mm.taunts||[]);
    if(taunts.length)return this._selectMove(taunts);
    const fallback=[];
    if(mm.stand?.length)fallback.push(...mm.stand.slice(0,2));
    if(mm.walkB?.length&&Math.random()<0.45)fallback.push(mm.walkB[0]);
    if(mm.crouch?.length&&Math.random()<0.22)fallback.push(mm.crouch[0]);
    return fallback.length?fallback[Math.random()*fallback.length|0]:null;
  }
  _doTaunt(mode='showboat'){
    const id=this._pickEmoteId();
    if(id==null)return false;
    if(this.f.doTaunt(id)){
      if(typeof game!=='undefined'&&game)MatchLog.evt(game,'TAUNT',this.f.char?.name,mode); // v11 fix
      this.emotion.showboat=Math.min(1,this.emotion.showboat+(mode==='bait'?0.08:0.12));
      this.emotion.dominance=Math.min(1,this.emotion.dominance+0.07);
      this.emotion.composure=Math.min(1,this.emotion.composure+0.03);
      if(this.f.snd)this.f.snd.playTaunt(mode==='bait'?0.62:0.76);
      return true;
    }
    return false;
  }
  _reactionToEnemyShowboat(dist){
    if(this.opp.justTaunted<=0||dist>this._spRv*2.2)return;
    this.emotion.anger=Math.min(1,this.emotion.anger+0.09);
    this.emotion.frustration=Math.min(1,this.emotion.frustration+0.07);
    this.emotion.tilt=Math.min(1,this.emotion.tilt+0.06);
    this.emotion.dominance=Math.max(0,this.emotion.dominance-0.04);
    if(this.plan!=='PUNISH'&&this.plan!=='ANTI_AIR'){
      this.plan=this.emotion.composure>0.48?'PRESSURE':'RUSH';
      this.planTimer=Math.max(this.planTimer,14+Math.random()*10|0);
    }
  }

  notifyWhiff(id){
    if(typeof game!=='undefined'&&game)MatchLog.whiff(game,this.f,id); // v11 fix
    this.moveWhiffs.set(id,(this.moveWhiffs.get(id)||0)+1);
    this.lastAtkHit=false;
    this.emotion.frustration=Math.min(1,this.emotion.frustration+0.05);
    this.emotion.tilt=Math.min(1,this.emotion.tilt+0.04);
    this.emotion.composure=Math.max(0, this.emotion.composure-0.02);
    // Remove from provenMoves if it keeps whiffing
    if((this.moveWhiffs.get(id)||0)>(this.moveHits.get(id)||0)*2)this.provenMoves?.delete(id);
  }
  notifyHit(){
    this.emotion.anger=Math.min(1,this.emotion.anger+0.08);
    this.emotion.frustration=Math.min(1,this.emotion.frustration+0.07);
    this.emotion.confidence=Math.max(0,this.emotion.confidence-0.06);
    this.emotion.fear=Math.min(1,this.emotion.fear+0.05);
    this.emotion.composure=Math.max(0,this.emotion.composure-0.05);
    this.emotion.tilt=Math.min(1,this.emotion.tilt+0.08);
    this.emotion.dominance=Math.max(0,this.emotion.dominance-0.06);
    this.hitsTaken++;
    // Aggression-dependent stun: aggressive AIs react faster
    this.stunCooldown=Math.round(14+Math.random()*10-(this.P.aggression*4));
    this.stunCooldown=Math.max(3,this.stunCooldown);
    this.planTimer=0;
    if(this.hitsTaken>=4&&this.hitsTaken%2===0){
      this.P.patience=Math.min(0.90,this.P.patience+0.03);
      if(this.f.hp/this.f.maxHp<0.5){
        this.stratBias.counter=Math.min(1,this.stratBias.counter+0.08);
      }
    }
  }
  notifyRoundEnd(won){
    // v9: fecha episódio de plano com bônus do resultado, decai e persiste
    this._closePlanEpisode(won?0.6:-0.6);
    this.predictor.decay(0.94);   // v13: apagava memória rápido demais
    this.bandit.decay(0.985);     // v13: tabela ficava com n≈1 (planilhas)
    // v12: atualiza o modelo de confronto e (re)escolhe contra-estilo
    if(this.matchup){
      this.matchup.roundEnd(won,this._rndTicks||300);
      this._applyStyle();
      if(typeof game!=='undefined'&&game&&this.matchup.style!==this._lastLoggedStyle){
        this._lastLoggedStyle=this.matchup.style;
        MatchLog.evt(game,'ESTILO',this.f.char?.name,
          this.matchup.style+' (wr '+this.matchup.wr.toFixed(2)+' gap '+this.matchup.powerGap().toFixed(2)+
          (this.matchup.style==='CUSTOM'?' spsa#'+(this.matchup.spsa?.iter||0):'')+')');
      }
    }
    this._rndTicks=0;
    try{AIMem.save(this.f.char?.name||'me',this.opp.char?.name||'op',
      {pred:this.predictor.serialize(),bandit:this.bandit.serialize(),
       matchup:this.matchup?.serialize(),planner:this.planner?.serialize()});}catch(e){}
    if(won){this.roundsWon++;this._streak=Math.max(0,this._streak)+1;}
    else   {this.roundsLost++;this._streak=Math.min(0,this._streak)-1;}
    this._adaptStrategy(won);
    this.hitsTaken=0;this.punishWindow=0;
    this.emotion.anger=Math.max(0,this.emotion.anger*(won?0.72:0.88));
    this.emotion.frustration=Math.max(0,this.emotion.frustration*(won?0.58:0.82));
    this.emotion.confidence=Math.max(0,Math.min(1,(this.emotion.confidence*(won?1.12:0.84))+(won?0.10:0)));
    this.emotion.fear=Math.max(0,Math.min(1,(this.emotion.fear*(won?0.74:0.96))+(won?0:0.05)));
    this.emotion.composure=Math.max(0.10,Math.min(1,(this.emotion.composure*(won?1.08:0.92))+(won?0.05:0)));
    this.emotion.tilt=Math.max(0,this.emotion.tilt*(won?0.55:0.84));
    this.emotion.dominance=Math.max(0,Math.min(1,(this.emotion.dominance*(won?1.12:0.80))+(won?0.10:0)));
    this.queue=[];this.qCooldown=0;
    this.stunCooldown=0;this.punishVisTimer=0;
    this._prevOppState=undefined;this._prevSelfState=undefined;
    this._reactCooldown=0;this.crouchCooldown=0;
    this._lastPickedId=-1;
    this.oppPattern.lastStates=[];
    this.oppPattern.sampleTick=0;
    this.passiveOppTicks=0;
    this.plan='NEUTRAL';this.planTimer=0;
    this.jumpCooldown=0;this.spCooldown=0;this.hyCooldown=0;this.guardCooldown=0;
    this._stallTicks=0;this._lastDist=9999;
    // Decay hit/whiff maps — BUG FIX: era 0.55/0.45, zeravam em 4-5 rounds destruindo memória cumulativa
    // Agora 0.88/0.82: dados antigos perdem peso gradualmente mas nunca somem por completo
    for(const[id,h]of this.moveHits){
      const nh=Math.max(0,Math.round(h*0.88));
      this.moveHits.set(id,nh);
      // BUG FIX: remover de provenMoves se hits decaíram — evita ghost bonus de movimentos esquecidos
      if(nh<1&&this.provenMoves?.has(id))this.provenMoves.delete(id);
    }
    for(const[id,w]of this.moveWhiffs)this.moveWhiffs.set(id,Math.max(0,Math.round(w*0.82)));
    // Decay heatmaps — era 0.52, agora 0.82 (mesma lógica: preservar forma, reduzir peso gradual)
    for(let i=0;i<5;i++){
      this.heatAtk[i]=Math.round(this.heatAtk[i]*0.82);
      this.heatDef[i]=Math.round(this.heatDef[i]*0.82);
    }
    // Decay routeScores — BUG FIX: sem decay significa rotas antigas dominam para sempre
    if(this.routeScores){
      for(const[k,v]of this.routeScores)this.routeScores.set(k,v*0.85);
    }
    this._recomputePreferredDist();
    this._reweightRoutes();
  }
  resetForNewRound(){
    this.queue=[];this.qCooldown=0;
    this.plan='NEUTRAL';this.planTimer=0;
    this.stunCooldown=0;this.punishWindow=0;this.punishVisTimer=0;
    this.jumpCooldown=0;this.spCooldown=0;this.hyCooldown=0;this.guardCooldown=0;this.crouchCooldown=0;
    this.interval=9;this.tick=this.interval-1;
    this.passiveOppTicks=0;
    this._reactCooldown=0;
    this._prevOppState=undefined;this._prevSelfState=undefined;
    this._stallTicks=0;
    this._lastX=this.f?.x??0;this._lastDist=9999;
    this.hitsTaken=0;this.lastAtkId=-1;this.lastAtkHit=false;
    this.emotion.anger*=0.35;this.emotion.frustration*=0.30;this.emotion.showboat=0;
    this.emotion.fear=Math.min(0.45,this.emotion.fear*0.70);
    this.emotion.composure=Math.max(0.36,Math.min(0.78,this.emotion.composure*0.96));
    this.emotion.tilt*=0.42;
    this.emotion.dominance=Math.max(0.08,Math.min(0.62,this.emotion.dominance*0.82));
    this.emotion.confidence=Math.max(0.12,Math.min(0.65,this.emotion.confidence*0.80));
    this.roundStartRushTicks=60;
    this._lastLogReason='reset';
    this._lastLogTick=0;
    // Re-init route list with current learned weights
    this._reweightRoutes();
  }

  _adaptStrategy(won){
    const opp=this.oppPattern;
    const deficit=this.winsRef.them-this.winsRef.me;
    const ar=this.P.adaptRate;
    const totalRounds=this.roundsWon+this.roundsLost;

    // Streak momentum — compounding personality shifts
    const streakMag=Math.min(4,Math.abs(this._streak));
    if(this._streak>=2){
      this.P.patience=Math.min(0.92,this.P.patience+0.025*streakMag);
      this.P.riskTaking=Math.max(0.12,this.P.riskTaking-0.018*streakMag);
    }else if(this._streak<=-2){
      this.P.aggression=Math.min(0.96,this.P.aggression+0.035*streakMag);
      this.P.riskTaking=Math.min(0.96,this.P.riskTaking+0.035*streakMag);
      this.P.patience=Math.max(0.08,this.P.patience-0.028*streakMag);
    }

    if(!won){
      // Counter opponent tactics
      if(opp.jumpFreq>0.18)  this.stratBias.zoning  =Math.min(1,this.stratBias.zoning  +0.20*ar);
      if(opp.aggrFreq>0.28)  this.stratBias.counter =Math.min(1,this.stratBias.counter +0.20*ar);
      if(opp.spamFreq>0.24)  this.stratBias.counter =Math.min(1,this.stratBias.counter +0.15*ar);
      if(opp.guardFreq>0.18) this.stratBias.rushdown =Math.min(1,this.stratBias.rushdown+0.18*ar);
      if(opp.hitTakenFreq>0.12){
        this.P.patience=Math.min(0.92,this.P.patience+0.07*ar);
        this.stratBias.counter=Math.min(1,this.stratBias.counter+0.12*ar);
      }
      // Losing badly — escalate risk
      if(deficit>=3){
        const scale=Math.min(1,deficit/6);
        this.P.riskTaking=Math.min(0.98,this.P.riskTaking+0.14*scale);
        this.P.aggression=Math.min(0.96,this.P.aggression+0.10*scale);
        this.P.patience  =Math.max(0.04,this.P.patience  -0.10*scale);
        this.hyCooldown=Math.max(0,this.hyCooldown-25);
        this.stratBias.rushdown=Math.min(1,this.stratBias.rushdown+0.22*ar);
      }else if(this.roundsLost>this.roundsWon+1){
        this.P.riskTaking=Math.min(0.92,this.P.riskTaking+0.09);
        this.stratBias.rushdown=Math.min(1,this.stratBias.rushdown+0.12*ar);
      }
      // Long series learning — if losing consistently, shift style more drastically
      if(totalRounds>4&&this.roundsLost>this.roundsWon*1.5){
        // Shake up strategy — try the least-used bias
        const biases=Object.entries(this.stratBias);
        const [minKey]=biases.sort(([,a],[,b])=>a-b)[0];
        this.stratBias[minKey]=Math.min(1,this.stratBias[minKey]+0.25);
      }
    }else{
      // Won: slightly consolidate what worked, cool down risks
      this.P.patience=Math.min(0.90,this.P.patience+0.03);
      if(deficit<-3)this.P.riskTaking=Math.max(0.12,this.P.riskTaking-0.06);
      // Gently decay all biases so winning styles don't fossilize
      for(const k of Object.keys(this.stratBias))
        this.stratBias[k]=Math.max(0,this.stratBias[k]-0.04*ar);
    }
    // Clamp personality
    this.P.aggression=Math.max(0.18,Math.min(0.97,this.P.aggression));
    this.P.patience  =Math.max(0.04,Math.min(0.92,this.P.patience));
    this.P.riskTaking=Math.max(0.08,Math.min(0.98,this.P.riskTaking));
  }

  _sampleOppState(){
    const s=this.oppPattern;
    s.sampleTick++;
    s.lastStates.push(this.opp.state);
    if(s.lastStates.length>60)s.lastStates.shift(); // larger window = more stable
    if(s.sampleTick%20===0&&s.lastStates.length>=20){ // sample every 20 ticks (was 30)
      const n=s.lastStates.length;
      s.jumpFreq  =s.lastStates.filter(x=>x==='JUMP'||x==='HIT_AIR').length/n;
      s.spamFreq  =s.lastStates.filter(x=>x==='ATTACK').length/n;
      s.aggrFreq  =s.lastStates.filter(x=>x==='WALK_F').length/n;
      s.guardFreq =s.lastStates.filter(x=>x==='GUARD').length/n;
      s.hitTakenFreq=s.lastStates.filter(x=>x==='HIT'||x==='HIT_AIR').length/n;
    }
  }
  // BUG FIX: _dangerZone returned zone 0 even when no hits received (all zeros)
  _dangerZone(){
    const max=Math.max(...this.heatDef);
    if(max===0)return -1; // -1 = no data yet, caller should ignore
    return this.heatDef.indexOf(max);
  }

  _selectMove(category){
    if(!category.length)return null;
    const meta=this.f.char.moveMap?.meta||{};
    const myPct=this.f.hp/this.f.maxHp;
    const deficit=(this.winsRef?.them||0)-(this.winsRef?.me||0);
    const sigSp=new Set(this.signatureSpecials||[]);
    const sigHy=new Set(this.signatureHypers||[]);
    const proven=this.provenMoves||new Set();
    const filtered=category.filter(id=>{
      const m=meta[id]||{};
      if(m.usable===false)return false;
      if(m.hasHitDef&&m.realDamage>0)return true;
      if(m.hasClsn1&&m.score>=5.0)return true;
      if(m.fromCommand==='special'||m.fromCommand==='hyper')return true;
      return false;
    });
    const pool=filtered.length?filtered:category;
    let totalW=0;
    const weights=pool.map(id=>{
      const h=this.moveHits.get(id)||0;
      const w=this.moveWhiffs.get(id)||0;
      const total=h+w;
      const m=meta[id]||{};
      // Base weight from empirical performance
      let wt=total===0?1.0:Math.max(0.12,(h/Math.max(1,total))*2.4+0.20);
      wt*=1+Math.min(1.25,Math.max(0,(m.score||0))/7);
      if(m.hasHitDef&&m.realDamage>0)wt*=1.30;
      // Proven moves get a strong bonus
      if(proven.has(id))wt*=1.55;
      // Deficit urgency: prefer specials/hypers
      if(deficit>=3&&(sigSp.has(id)||sigHy.has(id)))wt*=1.45;
      if(deficit>=5&&h>=w)wt*=1.35;
      // Low HP: prefer fast moves (low damage but safe) over hypers
      if(myPct<0.30&&m.fromCommand==='hyper'&&deficit<2)wt*=0.55;
      if(myPct<0.30&&(m.dur||99)<18)wt*=1.25;
      if(deficit<=-4&&total===0)wt*=0.80;
      if(id===this._lastPickedId)wt*=0.38;
      // v10: valor esperado condicionado ao GESTO PREVISTO do oponente
      const ph=this._predHint;
      if(ph&&this.predictor?.total>=8){
        if(ph.tok==='GUARD'&&this.crouchAtks?.includes(id))wt*=1+ph.p*0.60;          // baixo fura guarda alta
        if(ph.tok==='JUMP'&&this.antiAirMoves?.includes(id))wt*=1+ph.p*0.70;          // anti-aéreo pronto
        if((ph.tok==='ATK'||ph.tok==='SPC')&&(m.dur||99)<16)wt*=1+ph.p*0.35;          // troca com golpe rápido
        if(ph.tok==='BACK'&&(this.projectileMoves?.includes(id)))wt*=1+ph.p*0.45;     // recuo previsto → projétil
      }
      // v12: estilo ZONE_KEEPOUT prioriza projéteis
      if(this.styleK?.projBias&&this.projectileMoves?.includes(id))wt*=1+this.styleK.projBias*0.8;
      return wt;
    });
    weights.forEach(w=>totalW+=w);
    let r=Math.random()*Math.max(0.001,totalW);
    for(let i=0;i<pool.length;i++){
      r-=weights[i];
      if(r<=0){this._lastPickedId=pool[i];return pool[i];}
    }
    const picked=pool[pool.length-1];
    this._lastPickedId=picked;return picked;
  }

  _canUse(id){return this.f._canSpendFor?this.f._canSpendFor(id):true;}
  _usableList(arr){return (arr||[]).filter(id=>this._canUse(id));}
  _meterPct(){return (this.f.meter||0)/Math.max(1,this.f.maxMeter||1);}

  // ═══════════════════════════════════════════════════════════════
  //  v8 · USO INTELIGENTE DE HABILIDADES (anti-air · whiff punish · barra)
  // ═══════════════════════════════════════════════════════════════

  // Nível de ameaça/oportunidade 0..1 → modula a velocidade de reação
  _threatLevel(dist){
    const f=this.f,o=this.opp;let t=0;
    const z=this._zone(dist);
    if(z==='GRAB'||z==='CLOSE')t+=0.42; else if(z==='MID')t+=0.24;
    if(o.state==='ATTACK')t+=0.30;
    if((o.inAir||o.state==='JUMP')&&dist<this._spRv)t+=0.30;
    if(f.hp/f.maxHp<0.30)t+=0.18;
    if(this.punishWindow>0)t+=0.26;       // janela de punição → agir rápido
    return Math.min(1,t);
  }
  // Intervalo de decisão efetivo: mais curto sob ameaça/oportunidade e com mais "skill"
  _effInterval(){
    const thr=this._threatLevel(Math.abs(this.f.x-this.opp.x));
    const scale=(1.16-thr*0.60)*(1.10-this.reactionVar*0.20);
    return Math.max(4,Math.round(this.interval*scale));
  }

  // Decide a política de barra do round-instante (evita desperdício de super)
  _updateMeterPlan(dist){
    const f=this.f,o=this.opp;
    const mp=this._meterPct();
    const myPct=f.hp/f.maxHp,oppPct=o.hp/o.maxHp;
    const haveHy=!!(this.signatureHypers?.length||f.char.moveMap.hypers?.length);
    const deficit=(this.winsRef?.them||0)-(this.winsRef?.me||0);
    if(mp>=0.90){this._meterPlan='SPEND';return;}                       // barra cheia → não deixar estourar
    if(oppPct<0.28&&myPct>0.30){this._meterPlan='SPEND';return;}        // dá pra fechar o round
    if((o.inAir&&dist<this._spRv)||this._oppCornered()){this._meterPlan='SPEND';return;} // leitura confirmada
    if(haveHy&&mp>=0.60&&(myPct<0.30||this._isCornered())){this._meterPlan='SAVE_REVERSAL';return;} // guardar p/ reversal
    if(mp<0.60&&deficit>=1){this._meterPlan='BUILD';return;}            // atrás e sem barra → construir
    this._meterPlan='SPEND';
  }

  // Porteiro de HYPER: nunca solta super cru fora de alcance (o erro clássico do "super no vazio")
  _shouldCommitHyper(dist,confirmed){
    const f=this.f,o=this.opp;
    if(this.hyCooldown>0)return false;
    const hy=this._usableList(this.signatureHypers?.length?this.signatureHypers:f.char.moveMap.hypers||[]);
    if(!hy.length)return false;                       // sem barra ou sem hyper
    const oppPct=o.hp/o.maxHp,myPct=f.hp/f.maxHp;
    const inRange=dist<this._hyRv*1.02;
    if(confirmed&&inRange)return true;                // dentro de combo confirmado
    if(o.inAir&&dist<this._spRv)return true;          // super anti-aéreo
    if(this._oppCornered()&&inRange)return true;      // pressão garantida no canto
    if(oppPct<0.28&&myPct>0.30&&inRange)return true;  // super para fechar
    if(this._meterPlan==='SAVE_REVERSAL')
      return (this._isCornered()||myPct<0.22)&&dist<this._spRv*1.05; // só libera o reversal sob pressão real
    if(!inRange)return false;
    // Uso "cru" raro, proporcional a risco/raiva — evita spam de super no vazio
    return Math.random()<(this.P.riskTaking*0.20+this.emotion.anger*0.10);
  }

  // ANTI-AÉREO REATIVO — executa o golpe na reação (não só agenda um plano)
  _reactAntiAir(dist){
    if(this._aaCooldown>0)return false;
    const f=this.f,o=this.opp;
    if(f.state==='ATTACK'||f.state==='HIT'||f.inAir||f.hitstunFrames>0||this.queue.length)return false;
    const airborne=o.inAir||o.state==='JUMP'||o.state==='HIT_AIR';
    if(!airborne){this._oppAirTicks=0;return false;}
    this._oppAirTicks++;
    if(dist>this._spRv*1.05)return false;             // longe demais pra anti-aéreo
    const descending=(o.vy||0)>0;
    let p=0.40+this.reactionVar*0.42+(descending?0.12:0)+(this._oppAirTicks>=2?0.10:0);
    if(dist<this._hitRv*1.2)p+=0.10;                  // pulo profundo = anti-aéreo fácil
    if(Math.random()>Math.min(0.96,p))return false;
    f.facing=f.x<o.x?1:-1;
    const hy=this._usableList(this.signatureHypers?.length?this.signatureHypers:f.char.moveMap.hypers||[]);
    // Super anti-aéreo quando vale a pena gastar
    if(hy.length&&this._meterPlan==='SPEND'&&dist<this._spRv*0.92&&Math.random()<0.28+this.P.riskTaking*0.22){
      if(this._doAtk(this._selectMove(hy))){this.hyCooldown=55+Math.random()*30|0;this._aaCooldown=24+Math.random()*14|0;return true;}
    }
    const aa=this._usableList(this.antiAirMoves?.length?this.antiAirMoves:[...this.he,...this.airAtks]);
    const sp=this._usableList(this.signatureSpecials?.length?this.signatureSpecials:f.char.moveMap.specials);
    const pool=aa.length?aa:(sp.length&&!this.spCooldown?sp:(this.he.length?this.he:null));
    if(pool&&pool.length){
      const id=this._selectMove(pool);
      if(id!=null&&this._doAtk(id)){
        if(id>=1000)this.spCooldown=20+Math.random()*12|0;
        this._aaCooldown=20+Math.random()*12|0;
        this.plan='ANTI_AIR';this.planTimer=10;
        return true;
      }
    }
    // Sem anti-aéreo limpo → recua pra reposicionar
    if(Math.random()<0.5){this._walk('WALK_B',-f.facing*3.0);this._aaCooldown=10;return true;}
    return false;
  }

  // PUNISH DE WHIFF — converte recuperação do oponente em dano na reação
  _reactWhiffPunish(dist){
    if(this._punishCooldown>0)return false;
    const f=this.f,o=this.opp;
    if(f.state==='ATTACK'||f.state==='HIT'||f.inAir||f.hitstunFrames>0||f.landingLag>0||this.queue.length)return false;
    if(this.punishWindow<=0)return false;             // janela aberta pela camada reativa
    if(Math.random()>(0.42+this.reactionVar*0.46))return false; // skill: melhores IAs convertem mais
    f.facing=f.x<o.x?1:-1;
    const z=this._zone(dist);
    if(z==='GRAB'||z==='CLOSE'||z==='MID'){
      // Confirmado → pode investir no super (dentro do alcance)
      if(this._shouldCommitHyper(dist,true)){
        const hy=this._usableList(this.signatureHypers?.length?this.signatureHypers:f.char.moveMap.hypers||[]);
        const st=this._usableList(this.comboStarters?.length?this.comboStarters:this.li);
        const seq=[st.length?this._selectMove(st):null,this._selectMove(hy)].filter(x=>x!=null);
        if(seq.length){this._seq(seq);this.hyCooldown=50+Math.random()*28|0;this.punishWindow=0;this._punishCooldown=14;return true;}
      }
      const seq=this._pickAtk(dist);
      if(seq){this._seq(seq);this.punishWindow=0;this._punishCooldown=12;return true;}
    }
    if(dist>this._hitRv*0.95){                        // fora de alcance → corre pra converter
      this._run('RUN_F',f.facing*6.6,12);this._punishCooldown=6;return true;
    }
    return false;
  }

  // ═══ v12 · aplica o contra-estilo do matchup nos knobs da IA ═════
  _applyStyle(){
    const mm=this.matchup;if(!mm)return;
    this.styleK=mm.knobs();
    const k=this.styleK;
    if(k.agg!=null){ // estilo ativo sobrescreve personalidade
      this.P.aggression=k.agg;this.P.patience=k.pat;this.P.riskTaking=k.risk;
    }
    // Rubber-band legítimo: derrotas seguidas afiam reação/confirm (cap),
    // vitórias relaxam de volta ao talento base do personagem
    const ls=mm.lossStreak;
    if(ls>0){
      this.reactionVar=Math.min(0.98,this._baseReaction+ls*0.022);
      this.confirmSkill=Math.min(0.95,this._baseConfirm+ls*0.016);
    }else{
      this.reactionVar=Math.max(this._baseReaction,this.reactionVar-0.05);
      this.confirmSkill=Math.max(this._baseConfirm,this.confirmSkill-0.04);
    }
  }
  // ═══ v9 · contexto, episódios de plano e ganchos preditivos ═════
  _ctxKey(dist){return this._zone(dist)+'|'+this._lastOppTok;}
  _closePlanEpisode(bonus=0){
    const ep=this._planEpisode;if(!ep)return;
    // Recompensa = dano líquido normalizado durante o plano (+bônus de round)
    const dealt=(ep.oppHp-this.opp.hp)/Math.max(1,this.opp.maxHp);
    const taken=(ep.myHp -this.f.hp )/Math.max(1,this.f.maxHp);
    let r=(dealt-taken*1.05)*4+bonus;
    // v12: vencer trocas contra rival mais forte ensina mais
    if(this.matchup&&r>0)r*=this.matchup.rewardScale();
    this.bandit.reward(ep.ctx,ep.plan,r);
    if(ep.x&&ep.pIdx>=0)this.planner.learn(ep.x,ep.pIdx,r); // v13: SGD online
    this._planEpisode=null;
  }
  _openPlanEpisode(plan,dist){
    const pIdx=BANDIT_PLANS.indexOf(plan);
    this._planEpisode={plan,ctx:this._ctxKey(dist),myHp:this.f.hp,oppHp:this.opp.hp,
      x:pIdx>=0?this.planner.features(this,dist):null,pIdx}; // v13
    if(typeof game!=='undefined'&&game)MatchLog.evt(game,'PLANO',this.f.char?.name,plan+' @ '+this._planEpisode.ctx); // v11 fix
    this._selfPlanHist.push(plan);
    if(this._selfPlanHist.length>14)this._selfPlanHist.shift();
  }
  // v12: defesa reativa — bloquear ataque EM CURSO dentro do alcance.
  // Prob = base + reação + bônus de underdog + bônus do estilo; cooldown
  // curto e janela de punição armada ao soltar a guarda.
  _reactGuard(dist){
    const f=this.f,o=this.opp;
    if(this.guardCooldown>0||f.isAtk||f.inAir||f.state==='GUARD'||f.state==='HIT'||f.hitstunFrames>0)return false;
    if(o.state!=='ATTACK'||o.hasHit)return false;
    if(dist>this._hitRv*1.75)return false;
    let p=0.20+this.reactionVar*0.30
         +(this.matchup?this.matchup.guardBoost():0)
         +(this.styleK?.guardBoost||0);
    if(o.actId>=1000)p+=0.12;                 // especiais assustam mais
    if(this.emotion.fear>0.4)p+=0.08;
    if(Math.random()>Math.min(0.92,p))return false;
    f.facing=f.x<o.x?1:-1;
    f.setState('GUARD',{dur:14+Math.random()*12|0});
    this.guardCooldown=10+Math.random()*8|0;
    return true;
  }
  // Yomi: se repeti o mesmo plano 3x seguidas, fico previsível → bane-o
  _yomiBans(){
    const h=this._selfPlanHist,b=new Set();
    if(h.length>=3&&h.at(-1)===h.at(-2)&&h.at(-2)===h.at(-3))b.add(h.at(-1));
    return b;
  }
  // Ganchos preditivos: agir ANTES do gesto previsto do oponente
  _reactPredict(dist){
    const f=this.f,o=this.opp;
    if(f.isAtk||f.inAir||f.state==='HIT'||f.state==='GUARD'||f.hitstunFrames>0||this.queue.length)return false;
    if(this._predGuardCd>0)this._predGuardCd--;
    const hint=this._predHint;
    if(!hint||this.predictor.total<8)return false;     // precisa de amostra mínima
    const conf=hint.p*(0.55+this.reactionVar*0.50);    // skill modula a leitura
    // 1) PULO previsto → arma/realiza anti-aéreo antecipado
    if(hint.tok==='JUMP'&&conf>0.34&&dist<this._spRv*1.5&&!o.inAir){
      this._aaCooldown=0;                              // deixa o AA reativo pronto
      if(dist>this._spRv*0.85){this._walk('WALK_F',f.facing*3.4);return true;}
      if(Math.random()<conf*0.45){                     // AA totalmente preventivo
        const aa=this._usableList(this.antiAirMoves?.length?this.antiAirMoves:this.he);
        if(aa.length&&this._doAtk(this._selectMove(aa))){this._aaCooldown=18;return true;}
      }
      return false;
    }
    // 2) ATAQUE previsto de perto → guarda/recuo preditivo
    if((hint.tok==='ATK'||hint.tok==='SPC')&&conf>0.40&&dist<this._hitRv*1.6&&
       !this._predGuardCd&&!this.guardCooldown){
      this._predGuardCd=26+Math.random()*14|0;
      if(Math.random()<0.62){f.setState('GUARD',{dur:16+Math.random()*10|0});this.guardCooldown=18;return true;}
      this._walk('WALK_B',-f.facing*3.6);return true;
    }
    // 3) GUARDA prevista → mix-up: golpe baixo de perto ou bait recuando
    if(hint.tok==='GUARD'&&conf>0.42&&dist<this._hitRv*1.2){
      const low=this._usableList(this.crouchAtks||[]);
      if(low.length&&Math.random()<0.55){if(this._doAtk(this._selectMove(low)))return true;}
      if(Math.random()<0.30){this._walk('WALK_B',-f.facing*2.4);return true;}
    }
    return false;
  }

  _updatePlan(){
    if(this.planTimer>0){this.planTimer--;return;}
    const f=this.f,o=this.opp;
    const myPct=f.hp/f.maxHp,oppPct=o.hp/o.maxHp;
    const ag=this.P.aggression,pa=this.P.patience;
    const losing=this.roundsLost>this.roundsWon;
    const opp=this.oppPattern;
    const sb=this.stratBias;
    const dist=Math.abs(f.x-o.x);

    // ── Survival mode: HP < 25% — prioritise staying alive ──────────
    if(myPct<0.25){
      if(myPct<0.12){this.plan='LAST_STAND';this.planTimer=18+Math.random()*10|0;return;}
      // 12-25%: cautious but still dangerous
      this.plan=ag>0.65?'COMEBACK':'COUNTER_POKE';
      this.planTimer=24+Math.random()*14|0;return;
    }

    // ── Finish them: opp HP < 20% and we're healthy ─────────────────
    if(oppPct<0.20&&myPct>0.35&&ag>0.35){
      this.plan='FINISH';this.planTimer=28+Math.random()*16|0;return;
    }

    // ── Force override from punish window ───────────────────────────
    if(this.punishWindow>0){this.plan='PUNISH';return;}

    // FIX: Oponente encurralado → pressão máxima imediatamente
    if(this._oppCornered()&&myPct>0.25){
      const hasMeter=this._meterPct()>=0.50&&!this.hyCooldown&&(this.signatureHypers?.length||f.char.moveMap.hypers?.length);
      this.plan=hasMeter?'FINISH':'PRESSURE';
      this.planTimer=20+Math.random()*12|0;return;
    }

    // FIX #3: meter cheio → usar hyper urgentemente (estava ignorado completamente)
    const meterPct=this._meterPct();
    if(meterPct>=0.85&&!this.hyCooldown&&this._usableList(f.char.moveMap.hypers||[]).length){
      this.plan=myPct>0.45?'FINISH':'COMEBACK';
      this.planTimer=12+Math.random()*8|0;return;
    }
    // Meter alto (>60%) → empurrar especiais agressivamente
    if(meterPct>=0.60&&!this.spCooldown&&myPct>0.30){
      if(this.plan==='NEUTRAL'||this.plan==='GROUND_GAME'){
        this.plan='PRESSURE';this.planTimer=20+Math.random()*12|0;return;
      }
    }

    // ── React to opponent state ──────────────────────────────────────
    if(o.state==='ATTACK'&&Math.abs(f.x-o.x)<this._hitRv*1.8){
      this.plan='DODGE';this.planTimer=16+Math.random()*10|0;return;
    }
    if(o.inAir&&Math.abs(f.x-o.x)<this._spRv){
      this.plan='ANTI_AIR';this.planTimer=20+Math.random()*10|0;return;
    }

    // ── HP differential: big lead → pressure, behind → comeback ─────
    if(this._isSafeToShowboat(dist)&&this.emotion.showboat>0.28&&(this.emotion.dominance>0.34||this.emotion.confidence>0.58)&&Math.random()<0.28){
      this.plan='SHOWBOAT';this.planTimer=18+Math.random()*16|0;return;
    }
    if(myPct>oppPct+0.35&&ag>0.42){this.plan='PRESSURE';this.planTimer=55+Math.random()*40|0;return;}
    if(myPct<oppPct-0.28){
      this.plan=losing?'LAST_STAND':'COMEBACK';
      this.planTimer=40+Math.random()*28|0;return;
    }
    if(losing&&(this.roundsWon+this.roundsLost)>1){
      if(Math.min(0.92,ag+0.18)>0.58){this.plan='PRESSURE';this.planTimer=32+Math.random()*22|0;return;}
    }

    // ── Opponent pattern counters ────────────────────────────────────
    // v12: padrões do rival viram PRIORS do bandit (antes eram hard
    // returns e o aprendizado quase nunca rodava — aba IA vazia)
    const patPrior={};
    if(opp.jumpFreq>0.20&&pa>0.28)patPrior.GROUND_GAME=0.40;
    if(opp.spamFreq>0.25&&pa>0.30)patPrior.COUNTER_POKE=0.35;
    if(opp.guardFreq>0.16&&ag>0.32)patPrior.RUSH=0.35;
    if(opp.hitTakenFreq>0.16&&!losing)patPrior.COUNTER_POKE=(patPrior.COUNTER_POKE||0)+0.25;

    // ── v9: plano escolhido por APRENDIZADO (UCB1 contextual) ───────
    // priors = stratBias/personalidade; yomi bane plano repetido 3x;
    // recompensa = dano líquido medido durante o plano anterior
    const priors={
      RUSH        :(sb.rushdown+ag*0.55)*0.30+(patPrior.RUSH||0),
      ZONE        :(sb.zoning  +pa*0.35)*0.30,
      PRESSURE    :(sb.rushdown*0.5+ag*0.3)*0.30,
      GROUND_GAME :(sb.counter*0.5)*0.30+(patPrior.GROUND_GAME||0),
      COUNTER_POKE:(sb.counter*0.4)*0.30+(patPrior.COUNTER_POKE||0),
      NEUTRAL     :0.05,
    };
    // v12: vieses do contra-estilo ativo entram como priors
    const k=this.styleK||{};
    if(k.projBias)priors.ZONE=(priors.ZONE||0)+k.projBias*0.5;
    if(k.pokeOnly)priors.COUNTER_POKE=(priors.COUNTER_POKE||0)+0.35;
    if(k.allIn){priors.RUSH=(priors.RUSH||0)+0.55;priors.PRESSURE=(priors.PRESSURE||0)+0.30;}
    if(k.jumpBias>0.3)priors.RUSH=(priors.RUSH||0)+0.25;
    // v13: a rede pontua Q(s,plano) sobre features contínuas e soma aos
    // priors — Thompson tabular mantém a exploração estocástica
    {const xq=this.planner.q(this.planner.features(this,dist));
     for(let i=0;i<BANDIT_PLANS.length;i++)
       priors[BANDIT_PLANS[i]]=(priors[BANDIT_PLANS[i]]||0)+xq[i]*0.55;}
    const chosen=this.bandit.pick(this._ctxKey(dist),priors,this._yomiBans());
    this.plan=chosen;
    this.planTimer=({SHOWBOAT:20,RUSH:26,ZONE:34,PRESSURE:46,GROUND_GAME:38,COUNTER_POKE:32,NEUTRAL:18}[chosen]||18)+Math.random()*20|0;
  }

  _jump(vx){if(this.jumpCooldown>0)return false;this.f.setState('JUMP',{vx});this.jumpCooldown=55+Math.random()*30|0;return true;}
  _walk(state,vx){
    if(this.f.state!==state)this.f.setState(state,{keepVx:true});
    this.f._standMomentumTicks=0;
    this.f._walkTarget=Math.abs(vx)*(state==='WALK_B'?-1:1);
    this.f._moveSpeed=this.f._walkTarget;
    // Aplica vx já neste frame (evita delay de 1 tick antes do physics loop aplicar _moveSpeed)
    this.f.vx=this.f.facing*(state==='WALK_B'?-1:1)*Math.abs(vx);
  }
  _run(state,vx,dur=14){
    const target=(state==='RUN_B'?-1:1)*Math.abs(vx);
    if(this.f.state!==state)this.f.setState(state,{keepVx:true,dur});
    this.f._standMomentumTicks=0;
    this.f._walkTarget=target;
    this.f._moveSpeed=target;
    this.f.vx=this.f.facing*Math.abs(target)*(state==='RUN_B'?-1:1);
    this.f.runTimer=dur;
  }
  _routeUsable(seq){
    if(!seq?.length)return false;
    let meter=this.f.meter||0;
    let seenAtk=false;
    for(const id of seq){
      if(!this._canUse(id))return false;
      const m=this.f.char.moveMap.meta?.[id]||{};
      if(m.usable===false)return false;
      if(!(m.hasHitDef||m.hasClsn1||m.fromCommand==='special'||m.fromCommand==='hyper'))return false;
      const cost=this.f._moveCost?id>=0?this.f._moveCost(id):0:0;
      if(cost>meter)return false;
      meter-=cost;
      seenAtk=true;
    }
    return seenAtk;
  }
  _doAtk(id){
    if(this.f.doAtk(id)){this.lastAtkId=id;this.lastAtkHit=false;return true;}
    const mm=this.f.char.moveMap||{};
    const meta=mm.meta?.[id]||{};
    if((meta.fromCommand==='special'||meta.fromCommand==='hyper')&&this.f.state!=='ATTACK'){
      const fb=this._usableList((meta.fromCommand==='hyper'?(this.signatureHypers||mm.hypers):(this.signatureSpecials||mm.specials))||[]);
      for(const alt of fb){if(alt!==id&&this.f.doAtk(alt)){this.lastAtkId=alt;this.lastAtkHit=false;return true;}}
    }
    return false;
  }
  _antiStall(dist){
    const f=this.f,o=this.opp;
    const moved=Math.abs(f.x-this._lastX);
    const distDelta=Math.abs(dist-this._lastDist);
    const passive=f.state==='STAND'||f.state==='WALK_F'||f.state==='WALK_B'||f.state==='RUN_F'||f.state==='RUN_B'||f.state==='CROUCH';
    if(passive&&!f.inAir&&!f.isAtk&&moved<0.18&&distDelta<0.55)this._stallTicks++;
    else this._stallTicks=0;
    this._lastX=f.x;this._lastDist=dist;
    // Scale stall threshold by speed so anti-stall fires after the same REAL time regardless of turbo
    const stallThresh=Math.round(26*Math.max(1,_speedMult));
    if(this._stallTicks<stallThresh)return false;
    this.queue=[];this.qCooldown=0;this.stunCooldown=0;this.tick=this.interval;
    if(dist>this._spRv*1.15){this._run('RUN_F',f.facing*6.8,18);this._stallTicks=0;return true;}
    if(dist>this._hitRv*0.95){this._walk('WALK_F',f.facing*5.2);this._stallTicks=0;return true;}
    if(dist<this._hitRv*0.50){this._walk('WALK_B',-f.facing*3.6);this._stallTicks=0;return true;}
    const seq=this._pickAtk(dist);
    if(seq){this._seq(seq);this._stallTicks=0;return true;}
    if(dist>this._spRv*0.75){this._run('RUN_F',f.facing*5.8,12);this._stallTicks=0;return true;}
    if(this.bestNormal&&dist<this._hitRv*1.05){this._doAtk(this.bestNormal);this._stallTicks=0;return true;}
    this._walk('WALK_F',f.facing*4.6);this._stallTicks=0;return true;
  }
  // [E] Smart seq: cancela fila se saiu do alcance após primeiro hit
  _seq(ids){
    if(!ids||!ids.length)return;
    const seq=ids.filter(id=>id!==undefined&&id!==null);
    if(!seq.length)return;
    const first=seq.shift();
    if(first===undefined)return;
    if(!this._doAtk(first))return;
    this.queue=seq.filter(id=>this._canUse(id));
    if(!this.queue.every(id=>this._canUse(id))){this.queue=[];return;}
    this.qCooldown=3;
    // Track the full route for performance scoring
    this._currentRouteSeq=[first,...seq];
    this._currentRouteDmg=0;
  }

  // Cornered = back against a wall (opponent is in front, no room to retreat)
  // facing=1 → looking RIGHT → back is on LEFT wall → cornered if x<100
  // facing=-1 → looking LEFT → back is on RIGHT wall → cornered if x>CW-100
  _isCornered(){const f=this.f;return(f.x<100&&f.facing===1)||(f.x>CW-100&&f.facing===-1);}
  _oppCornered(){const o=this.opp;return(o.x<100&&o.facing===1)||(o.x>CW-100&&o.facing===-1);}

  // [B] Reactive Layer — dispara todo tick, respostas instantâneas
  _reactImmediate(dist,prevOppState,prevSelfState){
    if(this._reactCooldown>0){this._reactCooldown--;return false;}
    const f=this.f,o=this.opp;
    const myPct=f.hp/f.maxHp;

    // React to opponent starting an attack — instant guard (chance scales with HP loss)
    if(o.state==='ATTACK'&&prevOppState!=='ATTACK'&&!this.guardCooldown&&
       f.state!=='ATTACK'&&f.state!=='HIT'&&!f.inAir&&dist<this._hitRv*1.3){
      // FIX: era gc*0.22 → máximo 18%. Agora escala corretamente até 65%
      const guardBase=(this.P.patience*0.55)+(this.oppPattern.spamFreq*0.35);
      const hpBonus=myPct<0.40?0.30:myPct<0.65?0.14:0;
      const gc=Math.min(0.65,guardBase+hpBonus);
      if(Math.random()<gc){
        f.setState('GUARD',{dur:18+Math.random()*14|0});
        this.guardCooldown=38+Math.random()*20|0;
        this._reactCooldown=5;
        return true;
      }
    }

    if((o.state==='TAUNT'||o.justTaunted>0)&&dist<this._spRv*1.35&&f.state!=='ATTACK'&&!f.inAir){
      this.plan=this.emotion.anger>0.30?'RUSH':'PRESSURE';
      this.planTimer=28;
      this._reactCooldown=4;
      return false;
    }

    // React to opponent jumping
    if(o.inAir&&prevOppState!=='JUMP'&&o.state==='JUMP'&&dist<this._spRv*1.2&&
       f.state!=='ATTACK'&&f.state!=='HIT'){
      this.plan='ANTI_AIR';this.planTimer=28;
      this._reactCooldown=8;
      return false;
    }

    // React to opponent whiff — open punish window
    if(o.state!=='ATTACK'&&prevOppState==='ATTACK'&&!o.hasHit){
      this.punishWindow=36;
      this.punishVisTimer=36;
      this._reactCooldown=3;
      return false;
    }

    // Survival instinct: at very low HP, back off and guard opportunistically
    if(myPct<0.18&&f.state!=='ATTACK'&&!f.inAir&&o.state==='ATTACK'&&!this.guardCooldown){
      f.setState('GUARD',{dur:22+Math.random()*10|0});
      this.guardCooldown=50+Math.random()*20|0;
      this._reactCooldown=8;
      return true;
    }

    return false;
  }

  _pickAtk(dist){
    // v12: contra rival mais forte (powerGap alto), evita TROCAR dano —
    // sem vantagem clara (punição/previsão), prefere poke rápido e seguro
    if(this.matchup?.caution()&&this.punishWindow<=0){
      const ph=this._predHint;
      const adv=(ph&&(ph.tok==='GUARD'||ph.tok==='HIT')&&ph.p>0.45)||this.opp.state==='HIT';
      if(!adv&&Math.random()<(this.styleK?.pokeOnly?0.72:0.45)){
        const pokes=this._usableList(this.li);
        if(pokes.length)return[this._selectMove(pokes)];
        return null;
      }
    }
    const mm=this.f.char.moveMap;
    const sp=this._usableList(this.signatureSpecials?.length?this.signatureSpecials:mm.specials);
    const hy=this._usableList(this.signatureHypers?.length?this.signatureHypers:mm.hypers);
    const aa=this._usableList(this.antiAirMoves?.length?this.antiAirMoves:[...this.airAtks,...sp,...this.he]);
    const proj=this._usableList(this.projectileMoves?.length?this.projectileMoves:sp.filter(id=>mm.meta?.[id]?.isProjectile));
    const rush=this._usableList(this.rushMoves?.length?this.rushMoves:sp);
    const starters=this._usableList(this.comboStarters?.length?this.comboStarters:(this.li.length?this.li:mm.atkStand));
    const enders=this._usableList(this.comboEnders?.length?this.comboEnders:[...sp,...hy,...this.he,...this.mi]);
    const hitR=this._hitRv,spR=this._spRv,hyR=this._hyRv;
    const r=Math.random();
    const riskOk=!this.hyCooldown&&(r<(this.P.riskTaking+this.emotion.anger*0.12)||this.winsRef.them>this.winsRef.me+1);
    const spOk=!this.spCooldown&&(r<(this.P.aggression*0.78+0.22+this.emotion.confidence*0.08));
    const zone=this._zone(dist);
    const oppInAir=this.opp.inAir||this.opp.state==='HIT_AIR';
    const moveScore=id=>{const m=this.f.char.moveMap.meta?.[id]||{};return ((m.comboWeight)||0)+(this.moveHits.get(id)||0)*8-(this.moveWhiffs.get(id)||0)*5+(m.fromCommand==='special'?6:0)+(m.fromCommand==='hyper'?10:0)+(m.family?2.5:0)+(m.commandName?2:0)+(m.hasHitDef?3:0)+(this.provenMoves?.has(id)?6:0);};
    const routes=(this.routes||[]).filter(seq=>{
      if(!this._routeUsable(seq))return false;
      if(!seq?.length)return false;
      const last=seq[seq.length-1];
      if(last>=3000)return dist<hyR*1.05;
      if(last>=1000)return dist<spR*1.12;
      return dist<hitR*1.15;
    }).sort((a,b)=>b.reduce((n,id)=>n+moveScore(id),0)-a.reduce((n,id)=>n+moveScore(id),0)||b.length-a.length);

    if(oppInAir&&dist<spR*1.08){
      if(aa.length&&!this.spCooldown&&Math.random()<0.78){
        this.spCooldown=26+Math.random()*14|0;return [this._selectMove(aa)];
      }
      if(this.airAtks?.length)return [this._selectMove(this.airAtks)];
      if(this.he.length)return [this._selectMove(this.he)];
    }

    if(zone==='FAR'&&proj.length&&!this.spCooldown&&Math.random()<0.42){
      this.spCooldown=24+Math.random()*14|0;return [this._selectMove(proj)];
    }
    if((zone==='MID_FAR'||zone==='MID')&&rush.length&&!this.spCooldown&&Math.random()<0.30){
      this.spCooldown=26+Math.random()*16|0;return [this._selectMove(rush)];
    }

    if(hy.length&&riskOk&&dist<hyR&&this._shouldCommitHyper(dist,false)){
      const seq=routes.find(q=>q[q.length-1]>=3000)?.slice()||[this._selectMove(starters),this._selectMove(hy)].filter(Boolean);
      // FIX #4: hyCooldown reduzido de 78-126→50-85 ticks (~0.8-1.4s)
      this.hyCooldown=50+Math.random()*35|0;return seq;
    }
    if(sp.length&&spOk&&dist<spR*1.08&&Math.random()<0.88){
      const seq=routes.find(q=>q[q.length-1]>=1000&&q.length>=2)?.slice()||[this._selectMove(starters),this._selectMove(sp)].filter(Boolean);
      this.spCooldown=18+Math.random()*14|0;return seq;  // era 26-42 → 18-32
    }
    if(routes.length&&dist<Math.max(hitR*1.14,spR*1.02)){
      const pool=routes.filter(q=>{
        if(zone==='GRAB'||zone==='CLOSE')return q.length<=4;
        if(zone==='MID')return q[q.length-1]<3000 || hy.length===0;
        return q[q.length-1]>=1000;
      });
      // FIX #7: sortear aleatoriamente entre as top-3 rotas em vez de sempre a melhor
      // Evita combos idênticos repetitivos e expõe mais do moveset ao aprendizado
      if(pool.length&&Math.random()<0.94){
        const topN=pool.slice(0,Math.min(3,pool.length));
        return topN[Math.random()*topN.length|0].slice();
      }
    }
    if(this.crouchAtks.length&&(zone==='GRAB'||zone==='CLOSE')&&Math.random()<0.34){
      const c=this._selectMove(this.crouchAtks);
      if(sp.length&&!this.spCooldown&&Math.random()<0.58){
        this.spCooldown=28+Math.random()*16|0;return [c,this._selectMove(sp)].filter(Boolean);
      }
      return[c];
    }
    if(dist<Math.max(hitR,spR*0.90)){
      const r2=Math.random();
      if(r2<0.18&&this.bestNormal)return [this.bestNormal];
      if(r2<0.42&&starters.length)return [this._selectMove(starters),this._selectMove(this.mi.length?this.mi:enders)].filter(Boolean);
      if(r2<0.68&&enders.length)return [this._selectMove(starters),this._selectMove(this.mi.length?this.mi:enders),this._selectMove(enders)].filter(Boolean);
      if(sp.length&&!this.spCooldown&&r2<0.90){
        this.spCooldown=26+Math.random()*16|0;
        return [this._selectMove(starters),this._selectMove(sp)].filter(Boolean);
      }
      return [this.bestNormal||this._selectMove(starters.length?starters:mm.atkStand)];
    }
    if(zone==='MID'&&sp.length&&!this.spCooldown&&Math.random()<0.50){
      this.spCooldown=32+Math.random()*18|0;
      return [this._selectMove(sp)];
    }
    return null;
  }

  update(){
    const f=this.f,o=this.opp;

    // ── Always tick cooldowns and update state tracking ──────────
    // These run even during KO/GUARD/hitstun so cooldowns never freeze
    if(this.jumpCooldown>0)this.jumpCooldown--;
    if(this.spCooldown>0)this.spCooldown--;
    if(this.hyCooldown>0)this.hyCooldown--;
    if(this.guardCooldown>0)this.guardCooldown--;
    if(this.punishWindow>0)this.punishWindow--;
    if(this.punishVisTimer>0)this.punishVisTimer--;
    if(this.crouchCooldown>0)this.crouchCooldown--;
    if(this.stunCooldown>0)this.stunCooldown--;
    if(this._aaCooldown>0)this._aaCooldown--;          // v8
    if(this._punishCooldown>0)this._punishCooldown--;  // v8

    this._sampleOppState();
    this._rndTicks=(this._rndTicks||0)+1; // v12: relógio do round
    // v9: observa MUDANÇAS de gesto do oponente e atualiza a previsão
    const tokNow=gestureToken(o);
    if(tokNow!==this._lastOppTok){this.predictor.observe(tokNow);this._lastOppTok=tokNow;}
    this._predHint=this.predictor.best();
    const distNow=Math.abs(f.x-o.x);
    this._reactionToEnemyShowboat(distNow);
    const oppPassive=(o.state==='STAND'||o.state==='CROUCH')&&!o.isAtk&&!o.inAir;
    this.passiveOppTicks=oppPassive?Math.min(999,this.passiveOppTicks+1):Math.max(0,this.passiveOppTicks-2);

    // Whiff detection — runs regardless of current state
    if(f.state!=='ATTACK'&&this._prevSelfState==='ATTACK'&&!f.hasHit&&this.lastAtkId>=0){
      this.notifyWhiff(this.lastAtkId);this.lastAtkId=-1;
    }
    // Always update prev states to keep reactive layer accurate
    const prevOpp=this._prevOppState;
    const prevSelf=this._prevSelfState;
    this._prevOppState=o.state;
    this._prevSelfState=f.state;

    // ── Early returns — combat actions blocked ───────────────────
    if(f.state==='KO')return;
    if(f.state==='TAUNT')return;
    if(f.state==='GUARD'){
      // During guard: still react to whiff opportunities to punish on guard release
      if(o.state!=='ATTACK'&&prevOpp==='ATTACK'&&!o.hasHit){
        this.punishWindow=32;this.punishVisTimer=32;
      }
      return;
    }
    if(f.hitstunFrames>0||f.landingLag>0||f.state==='HIT'||f.state==='HIT_AIR')return;

    const dist=Math.abs(f.x-o.x);
    // v12: em confronto perdido, NÃO entrar no rush de início de round —
    // nas planilhas o round era decidido no primeiro engajamento
    if(this.matchup?.skipRush()&&(this._forceEngageTicks>0||this.roundStartRushTicks>0)){
      this._forceEngageTicks=0;
      this.roundStartRushTicks=0;
      const k=this.styleK||{};
      if(k.engageDelay>0&&this._rndTicks<k.engageDelay){
        // recua/espaça enquanto observa o rival abrir o jogo
        if(dist<this._spRv*1.4){this._walk('WALK_B',-f.facing*3.2);return;}
        return;
      }
    }
    if(this._forceEngageTicks>0){
      this._forceEngageTicks--;
      if(!f.inAir&&f.state!=='ATTACK'&&f.state!=='GUARD'){
        f.facing=f.x<o.x?1:-1;
        if(dist>this._hitRv*0.92){
          this._walk('WALK_F',f.facing*(dist>this._spRv?4.6:3.8));
          return;
        }
        const forced=this._pickAtk(dist);
        if(forced){this.queue=[];this._seq(forced);return;}
        if(this.bestNormal){this._doAtk(this.bestNormal);return;}
      }
    }
    // Decrement roundStartRushTicks regardless so it doesn't double the forced engagement window
    if(this.roundStartRushTicks>0){
      this.roundStartRushTicks--;
      if(this._forceEngageTicks<=0&&!f.inAir&&f.state!=='ATTACK'&&f.state!=='GUARD'){
        f.facing=f.x<o.x?1:-1;
        if(dist>this._hitRv*0.78){
          this._walk('WALK_F',f.facing*(dist>this._spRv?4.4:3.6));
          return;
        }
      }
    }
    if(this._antiStall(dist))return;

    // [B] Reactive layer
    const reacted=this._reactImmediate(dist,prevOpp,prevSelf);
    if(reacted)return;
    // v9: camada PREDITIVA — age antes do gesto previsto do oponente
    if(this._reactPredict(dist))return;
    // v12: defesa REATIVA — bloquear ataques em curso (faltava: 171
    // bloqueios em 34k eventos nas planilhas analisadas)
    if(this._reactGuard(dist))return;
    // v8: reações executoras de habilidade (anti-aéreo na reação + punish de whiff)
    if(this._reactAntiAir(dist))return;
    if(this._reactWhiffPunish(dist))return;
    if(this.passiveOppTicks>45){this.emotion.showboat=Math.min(1,this.emotion.showboat+0.005); if(this._canTaunt(dist)&&this.passiveOppTicks>70&&!this.guardCooldown&&Math.random()<0.015){this._doTaunt();return;}}

    // Always face opponent when free (crossup detection included)
    if(f.state!=='ATTACK'&&f.state!=='HIT'&&!f.inAir){
      f.facing=f.x<o.x?1:-1;
    }
    if(f.inAir&&f.state==='JUMP'){
      const nf=f.x<o.x?1:-1;if(nf!==f.facing)f.facing=nf;
    }

    // [E] Combo queue processing
    if(this.queue.length){
      if(f.state==='HIT'||f.state==='KO'){this.queue=[];this.qCooldown=0;return;}
      if(f.state==='ATTACK'){
        const canCancel=f.fi>=(f._cancelStart??9999)&&f.fi<=(f._cancelEnd??-1);
        if(!f.hasHit&&this.queue.length>1&&f.fi>(f._activeEnd??0)){this.queue.length=0;this.qCooldown=0;}
        if(canCancel&&f.hasHit&&this.queue.length){this._doAtk(this.queue.shift());this.qCooldown=3;}
        return;
      }
      if(this.qCooldown>0){this.qCooldown--;return;}
      if(dist>this._spRv*1.1&&this.queue.length>0){this.queue=[];this.qCooldown=0;}
      else{this._doAtk(this.queue.shift());this.qCooldown=4;}
      return;
    }

    // FIX #2: probabilidade 14%→30% e alcance spRv*0.9→spRv*1.3
    // 14% por frame ainda fica <50% em jumps curtos (pico de 6-8 frames perto do oponente)
    if(f.inAir&&!f.airAtkDone&&dist<this._spRv*1.3&&Math.random()<(0.30+this.reactionVar*0.25)){
      const mm=f.char.moveMap;
      const pool=this._usableList(mm.atkAir.length?mm.atkAir:(mm.atkStand.length?mm.atkStand:[]));
      if(pool?.length){if(f.doAtk(this._selectMove(pool)))f.airAtkDone=true;return;}
    }

    if(f.state==='ATTACK')return;

    // ── Decision tick ─────────────────────────────────────────────
    if(++this.tick<this._effInterval())return; // v8: cadência adaptativa por ameaça/skill
    this.tick=0;
    // Post-attack mandatory pause: if we just finished attacking, wait a bit
    // FIX #8: era 8-14 → 4-9 para planos agressivos, normal para defensivos
    if(prevSelf==='ATTACK'&&f.state!=='ATTACK'){
      const aggressivePlan=this.plan==='RUSH'||this.plan==='PRESSURE'||this.plan==='PUNISH'||this.plan==='FINISH'||this.plan==='LAST_STAND';
      this.stunCooldown=Math.max(this.stunCooldown,(aggressivePlan?4:7)+Math.random()*5|0);
    }

    this._updateMeterPlan(dist); // v8: define política de barra antes do plano
    this._updatePlan();
    // v12: estilo AIR_ASSAULT — aproximação aérea deliberada
    const jb=this.styleK?.jumpBias||0;
    if(jb>0&&!f.inAir&&!this.jumpCooldown&&f.state!=='ATTACK'&&f.state!=='GUARD'&&
       dist<this._spRv*1.6&&dist>this._hitRv*0.7&&Math.random()<jb*0.10){
      this._jump(f.facing*3.6);this.jumpCooldown=30;return;
    }
    // v12: episódio de recompensa acompanha QUALQUER plano vigente
    if(this.plan!==this._planEpisode?.plan){
      this._closePlanEpisode();
      this._openPlanEpisode(this.plan,dist);
    }
    if(this.stunCooldown>0)return; // wait out stun before executing plan

    const hitR=this._hitRv,spR=this._spRv;
    const mm=f.char.moveMap;
    // FIX #6: usar signatureSpecials/Hypers (pre-ordenados por score) em vez de mm.specials/hypers raw
    const sp=this._usableList(this.signatureSpecials?.length?this.signatureSpecials:mm.specials);
    const hy=this._usableList(this.signatureHypers?.length?this.signatureHypers:mm.hypers);
    const r=Math.random();
    const zone=this._zone(dist); // [A]

    // [D] Agachar defensivo sob pressão
    if(!this.crouchCooldown&&f.state!=='ATTACK'&&!f.inAir&&
       this.hitsTaken>=3&&o.state==='ATTACK'&&(zone==='CLOSE'||zone==='GRAB')&&Math.random()<0.15){
      f.setState('CROUCH');
      this.crouchCooldown=40+Math.random()*20|0;
      return;
    }

    // ── CORNER ESCAPE ─────────────────────────────────────────────
    if(this._isCornered()&&zone!=='FAR'&&r<0.60){
      if(!this.jumpCooldown){this._jump(f.facing*5.8);return;}
      this._walk('WALK_B',-f.facing*4.5);return;
    }

    // ── PUNISH ────────────────────────────────────────────────────
    if(this.plan==='PUNISH'){
      this.interval=7+Math.random()*4|0;  // FIX #8: era 10-16 → 7-11
      if(zone==='FAR'){this._run('RUN_F',f.facing*6.8,16);return;}
      if(zone==='MID_FAR'){this._walk('WALK_F',f.facing*5.5);return;}
      const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      this._walk('WALK_F',f.facing*5.5);return;
    }

    // ── LAST_STAND ────────────────────────────────────────────────
    if(this.plan==='LAST_STAND'){
      this.interval=14+Math.random()*7|0; // was 5-9 — that's every 83-150ms, too robotic
      if(zone==='FAR'){this._run('RUN_F',f.facing*7.0,18);return;}
      if(zone==='MID_FAR'){this._walk('WALK_F',f.facing*5.8);return;}
      if(hy.length&&!this.hyCooldown&&r<0.55){
        const seq=[this._selectMove(hy)];
        if(this.li.length)seq.unshift(this._selectMove(this.li));
        this.hyCooldown=60+Math.random()*30|0;this._seq(seq);return;
      }
      if(sp.length&&!this.spCooldown&&r<0.80){
        this.spCooldown=30+Math.random()*15|0;this._seq([this._selectMove(sp)]);return;
      }
      const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      this._walk('WALK_F',f.facing*5.5);return;
    }

    // ── FINISH ────────────────────────────────────────────────────
    if(this.plan==='FINISH'){
      this.interval=8+Math.random()*5|0;
      if(dist>hitR*1.15){this._run('RUN_F',f.facing*5.2,10);return;}
      // FIX: FINISH usa cadeia completa starter→mi→hyper/special ao invés de só _pickAtk
      const starters=this._usableList(this.comboStarters?.length?this.comboStarters:this.li);
      const hy2=this._usableList(this.signatureHypers?.length?this.signatureHypers:f.char.moveMap.hypers||[]);
      if(hy2.length&&!this.hyCooldown&&r<0.60){
        const s=starters.length?this._selectMove(starters):null;
        const m=this.mi.length?this._selectMove(this._usableList(this.mi)):null;
        const h=this._selectMove(hy2);
        this._seq([s,m,h].filter(Boolean));
        this.hyCooldown=48+Math.random()*28|0;return;
      }
      const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      this._walk('WALK_F',f.facing*4.5);return;
    }

    // ── DODGE ─────────────────────────────────────────────────────
    if(this.plan==='DODGE'){
      this.interval=12+Math.random()*7|0; // was 8-13
      // KOF2002: evade attacks by backdashing or jumping over
      if(r<0.40){this._run('RUN_B',-f.facing*6.0,10);return;} // quick backdash
      if(r<0.62&&!this.jumpCooldown){this._jump(-f.facing*3.8);return;} // jump away
      if(r<0.78&&(zone==='CLOSE'||zone==='MID')&&this.li.length&&!this.stunCooldown){
        // Counter-poke after dodge attempt
        this._doAtk(this._selectMove(this.li));return;
      }
      this._walk('WALK_B',-f.facing*4.2);return;
    }

    // ── ANTI_AIR ─────────────────────────────────────────────────
    if(this.plan==='ANTI_AIR'){
      this.interval=10+Math.random()*6|0; // was 6-10
      if(zone==='GRAB'){this._walk('WALK_B',-f.facing*3.2);return;}
      if((zone==='FAR'||zone==='MID_FAR')&&r<0.4){this._walk('WALK_F',f.facing*3.2);return;}
      // KOF2002: anti-air specials have high priority (like Kyo's 75shiki)
      const aa=this._usableList(this.antiAirMoves?.length?this.antiAirMoves:[...sp,...this.airAtks,...this.he]);
      if(aa.length&&!this.spCooldown&&r<0.76&&zone!=='FAR'){
        this.spCooldown=24+Math.random()*16|0;this._doAtk(this._selectMove(aa));return;
      }
      if(hy.length&&!this.hyCooldown&&r<0.30&&zone!=='FAR'){
        this.hyCooldown=70+Math.random()*40|0;this._doAtk(this._selectMove(hy));return;
      }
      if(zone!=='FAR'&&r<0.64){const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}}
      f.setState('STAND');return;
    }
    // ── SHOWBOAT / BAIT ────────────────────────────────────────
    if(this.plan==='SHOWBOAT'){
      this.interval=14+Math.random()*8|0;
      if(!this._isSafeToShowboat(dist)){
        this.plan=this.emotion.composure>0.54?'NEUTRAL':'PRESSURE';
        this.planTimer=10+Math.random()*10|0;
      }else{
        if(this._canTaunt(dist)&&r<0.48){this._doTaunt(this.emotion.dominance>0.55?'showboat':'bait');return;}
        if(r<0.28){this._walk('WALK_B',-f.facing*2.0);return;}
        if(r<0.52){this._walk('WALK_F',f.facing*2.2);return;}
        if(r<0.68&&sp.length&&!this.spCooldown&&dist<this._spRv*1.15){
          this.spCooldown=30+Math.random()*18|0;this._doAtk(this._selectMove(sp));return;
        }
        f.setState('STAND',{stopNow:true});return;
      }
    }


    // ── COMEBACK ─────────────────────────────────────────────────
    if(this.plan==='COMEBACK'){
      this.interval=13+Math.random()*8|0; // was 9-15
      if(zone==='FAR'){this._run('RUN_F',f.facing*6.6,15);return;}
      if(zone==='MID_FAR'){this._walk('WALK_F',f.facing*5.0);return;}
      if(hy.length&&!this.hyCooldown&&r<0.40){
        this.hyCooldown=75+Math.random()*40|0;
        const seq=[this._selectMove(hy)];
        if(this.li.length)seq.unshift(this._selectMove(this.li));
        this._seq(seq);return;
      }
      if(sp.length&&!this.spCooldown&&r<0.65){
        this.spCooldown=22+Math.random()*14|0;this._doAtk(this._selectMove(sp));return;
      }
      const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      this._walk('WALK_F',f.facing*4.5);return;
    }

    // ── PRESSURE ─────────────────────────────────────────────────
    if(this.plan==='PRESSURE'){
      this.interval=11+Math.random()*6|0;
      const rush=this._usableList(this.rushMoves?.length?this.rushMoves:sp);
      const starters=this._usableList(this.comboStarters?.length?this.comboStarters:this.li);
      const enders=this._usableList(this.comboEnders?.length?this.comboEnders:[...sp,...this.he]);
      if(zone==='FAR'||zone==='MID_FAR'){
        if(this._canTaunt(dist)&&r<0.06){this._doTaunt();return;}
        if(r<0.46){this._run('RUN_F',f.facing*6.1,12);return;}
        if(r<0.62&&!this.jumpCooldown){this._jump(f.facing*3.8);return;}
        // FIX: usar rushMoves para aproximação agressiva
        if(rush.length&&!this.spCooldown&&r<0.78){
          this.spCooldown=22+Math.random()*14|0;this._doAtk(this._selectMove(rush));return;
        }
        if(sp.length&&!this.spCooldown&&r<0.90){
          this.spCooldown=22+Math.random()*14|0;this._doAtk(this._selectMove(sp));return;
        }
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
        this._walk('WALK_F',f.facing*4.0);
      }else{
        // CLOSE/MID/GRAB: executar cadeia starter→mi→ender completa
        if(r<0.06){this._walk('WALK_B',-f.facing*1.8);return;}
        if(starters.length&&enders.length&&!this.spCooldown&&r<0.50){
          const s=this._selectMove(starters);
          const m=this.mi.length?this._selectMove(this._usableList(this.mi)):null;
          const e=this._selectMove(enders);
          this._seq([s,m,e].filter(Boolean));
          this.spCooldown=22+Math.random()*12|0;return;
        }
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
        this._walk('WALK_F',f.facing*3.5);
      }
      return;
    }

    // ── RUSH ─────────────────────────────────────────────────────
    if(this.plan==='RUSH'){
      this.interval=8+Math.random()*5|0;
      const rush=this._usableList(this.rushMoves?.length?this.rushMoves:sp);
      const starters=this._usableList(this.comboStarters?.length?this.comboStarters:this.li);
      const enders=this._usableList(this.comboEnders?.length?this.comboEnders:[...sp,...this.he]);
      if(zone==='FAR'){
        // FIX: rush moves para fechar distância rapidamente
        if(rush.length&&!this.spCooldown&&r<0.45){
          this.spCooldown=20+Math.random()*12|0;this._doAtk(this._selectMove(rush));return;
        }
        if(r<0.55){this._run('RUN_F',f.facing*5.8,14);return;}
        if(!this.jumpCooldown&&r<0.80){this._jump(f.facing*4.5);return;}
        this._walk('WALK_F',f.facing*4.5);
      }else if(zone==='MID_FAR'||zone==='MID'){
        if(rush.length&&!this.spCooldown&&r<0.42){
          this.spCooldown=22+Math.random()*12|0;this._doAtk(this._selectMove(rush));return;
        }
        if(sp.length&&!this.spCooldown&&r<0.60){
          this.spCooldown=24+Math.random()*14|0;this._doAtk(this._selectMove(sp));return;
        }
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
        this._walk('WALK_F',f.facing*4.5);
      }else{
        // CLOSE: cadeia rápida starter→ender ou rush cancel
        if(starters.length&&!this.spCooldown&&r<0.55){
          const s=this._selectMove(starters);
          const e=enders.length?this._selectMove(enders):null;
          this._seq([s,e].filter(Boolean));
          this.spCooldown=18+Math.random()*10|0;return;
        }
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      }
      return;
    }

    // ── ZONE ─────────────────────────────────────────────────────
    if(this.plan==='ZONE'){
      this.interval=13+Math.random()*8|0;
      const proj=this._usableList(this.projectileMoves?.length?this.projectileMoves:sp.filter(id=>f.char.moveMap.meta?.[id]?.isProjectile));
      // [C] preferredDist como alvo — aprende onde ataques conectam melhor
      const idealDist=this.preferredDist>0?Math.min(this.preferredDist,hitR*1.8):hitR*1.6;
      // FIX: projéteis são a principal arma do plano ZONE — prioridade máxima na distância ideal
      if(proj.length&&!this.spCooldown&&dist>hitR*0.9){
        this.spCooldown=26+Math.random()*16|0;this._doAtk(this._selectMove(proj));return;
      }
      if(dist>idealDist+110){this._run('RUN_F',f.facing*6.5,14);return;}
      if(dist>idealDist+40){this._walk('WALK_F',f.facing*3.0);return;}
      if(dist<idealDist-40){this._walk('WALK_B',-f.facing*2.8);return;}
      if(sp.length&&!this.spCooldown&&r<0.50){
        this.spCooldown=26+Math.random()*16|0;this._doAtk(this._selectMove(sp));return;
      }
      // [C] bestNormal como poke confiável
      if(r<0.35&&(zone==='MID'||zone==='CLOSE')){
        const m=this.bestNormal||(this.li.length?this._selectMove(this.li):null);
        if(m){this._doAtk(m);return;}
      }
      if(!this.jumpCooldown&&r<0.20){this._jump(f.facing*2.5);return;}
      f.setState('STAND');return;
    }

    // ── GROUND_GAME ───────────────────────────────────────────────
    if(this.plan==='GROUND_GAME'){
      this.interval=12+Math.random()*7|0;
      if(zone==='FAR'||zone==='MID_FAR'){
        if(r<0.55){this._walk('WALK_F',f.facing*3.5);return;}
        if(sp.length&&!this.spCooldown&&r<0.75){
          this.spCooldown=24+Math.random()*14|0;this._doAtk(this._selectMove(sp));return;
        }
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
        this._walk('WALK_F',f.facing*3.2);
      }else{
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
        this._walk('WALK_F',f.facing*3.0);
      }
      return;
    }

    // ── COUNTER_POKE ──────────────────────────────────────────────
    if(this.plan==='COUNTER_POKE'){
      this.interval=13+Math.random()*8|0;
      if(o.state==='ATTACK'&&(zone==='CLOSE'||zone==='MID')){
        if(r<0.40&&!this.jumpCooldown){this._jump(-f.facing*2.8);return;}
        if(r<0.65){this._walk('WALK_B',-f.facing*4.2);return;}
      }
      if((zone==='CLOSE'||zone==='GRAB')&&o.state!=='ATTACK'){
        const seq=this._pickAtk(dist);if(seq){this._seq(seq);return;}
      }
      // BUG FIX: only use dangerZone if we have actual data (-1 = no data)
      const danger=this._dangerZone();
      if(danger>=0){
        const myZone=Math.min(4,Math.floor(f.x/CW*5));
        if(this.heatDef[danger]>3&&myZone===danger&&r<0.50){
          this._walk('WALK_B',-f.facing*3.0);return;
        }
      }
      if(zone==='FAR'||zone==='MID_FAR'){this._walk('WALK_F',f.facing*3.0);return;}
      if(zone==='MID'&&this.bestNormal&&r<0.42){this._doAtk(this.bestNormal);return;}
      if(r<0.38){this._walk('WALK_B',-f.facing*2.5);return;}
      f.setState('STAND');return;
    }

    // ── NEUTRAL ──────────────────────────────────────────────────
    this.interval=12+Math.random()*8|0;
    switch(zone){
      case'FAR':
        // FIX #5: projéteis são ideais em FAR — verificar antes de andar
        if(this.projectileMoves.length&&!this.spCooldown&&Math.random()<0.52){
          const pj=this._usableList(this.projectileMoves);
          if(pj.length){this.spCooldown=28+Math.random()*14|0;this._doAtk(this._selectMove(pj));break;}
        }
        if(r<0.50)this._walk('WALK_F',f.facing*4.0);
        else if(r<0.72&&!this.jumpCooldown)this._jump(f.facing*4.2);
        else this._walk('WALK_F',f.facing*3.5);
        break;
      case'MID_FAR':
        if(r<0.38)this._walk('WALK_F',f.facing*3.4);
        else if(r<0.56&&!this.jumpCooldown)this._jump(f.facing*3.2);
        else if(r<0.70)this._walk('WALK_B',-f.facing*2.0);
        else if(sp.length&&!this.spCooldown&&r<0.88){this.spCooldown=28+Math.random()*14|0;this._doAtk(this._selectMove(sp));}
        else this._walk('WALK_F',f.facing*3.0);
        break;
      case'MID':
        if(sp.length&&r<0.32&&!this.spCooldown){
          this.spCooldown=28+Math.random()*14|0;this._doAtk(this._selectMove(sp));
        // FIX #5: usar crouch attacks em MID para pressionar guards
        }else if(this.crouchAtks.length&&r<0.48&&!this.crouchCooldown){
          const ca=this._usableList(this.crouchAtks);
          if(ca.length){this._doAtk(this._selectMove(ca));break;}
          if(r<0.50)this._walk('WALK_F',f.facing*3.0);
          else if(r<0.65&&!this.jumpCooldown)this._jump(f.facing*2.6);
          else if(this.bestNormal&&r<0.82)this._doAtk(this.bestNormal);
          else this._walk('WALK_B',-f.facing*2.2);
        }else if(r<0.50)this._walk('WALK_F',f.facing*3.0);
        else if(r<0.65&&!this.jumpCooldown)this._jump(f.facing*2.6);
        else if(this.bestNormal&&r<0.82)this._doAtk(this.bestNormal);
        else this._walk('WALK_B',-f.facing*2.2);
        break;
      default:{ // CLOSE ou GRAB
        const seq=this._pickAtk(dist);
        if(seq)this._seq(seq);
        else if(r<0.18&&!this.jumpCooldown)this._jump(f.facing*2.8); // tick throw bait
        else if(r<0.32)this._walk('WALK_B',-f.facing*2.5);
        else this._walk('WALK_F',f.facing*2.8);
        break;
      }
    }
  }
}


