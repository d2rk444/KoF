// core.js — constantes, áudio, parsers SFF/AIR/SND, cenário (Stage), MatchLog/planilha

// ═══════════════════════════════════════════════════════════════
//  v10 · CENÁRIO DE FUNDO ("fundo")
//  Aceita 1 imagem ou um .zip de imagens; cicla a cada round
// ═══════════════════════════════════════════════════════════════
const Stage={
  imgs:[],urls:[],idx:0,
  current(){return this.imgs.length?this.imgs[this.idx%this.imgs.length]:null;},
  currentUrl(){return this.urls.length?this.urls[this.idx%this.urls.length]:null;},
  next(){if(this.imgs.length>1)this.idx=(this.idx+1)%this.imgs.length;this.applyDom();},
  // Preenche TODA a tela (inclusive as barras fora do canvas 16:9)
  applyDom(){
    const fs=document.getElementById('fight-screen');if(!fs)return;
    const u=this.currentUrl();
    if(u)fs.style.background=`linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url("${u}") center/cover no-repeat #000`;
    else fs.style.background='#000';
  },
  async _bitmapFromBlob(blob){
    try{return await createImageBitmap(blob);}catch(e){
      return await new Promise((res,rej)=>{
        const u=URL.createObjectURL(blob),im=new Image();
        im.onload=()=>{URL.revokeObjectURL(u);res(im);};
        im.onerror=rej;im.src=u;});
    }
  },
  async _add(found,blob){
    try{
      const bmp=await this._bitmapFromBlob(blob);
      found.push({bmp,url:URL.createObjectURL(blob)});
    }catch(err){}
  },
  async load(file){
    if(!file)return 0;
    const found=[];
    if(/\.zip$/i.test(file.name)){
      const zip=await JSZip.loadAsync(file);
      const entries=Object.values(zip.files)
        .filter(f=>!f.dir&&/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
        .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      for(const e of entries)await this._add(found,await e.async('blob'));
    }else if(/^image\//.test(file.type)||/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)){
      await this._add(found,file);
    }
    if(found.length){
      for(const u of this.urls)try{URL.revokeObjectURL(u);}catch(e){}
      this.imgs=found.map(f=>f.bmp);
      this.urls=found.map(f=>f.url);
      this.idx=0;this.applyDom();
    }
    return found.length;
  },
  // Desenho "cover" + leve escurecida p/ legibilidade dos lutadores e HUD
  draw(ctx){
    const im=this.current();if(!im)return false;
    const iw=im.width,ih=im.height;
    const s=Math.max(CW/iw,CH/ih),dw=iw*s,dh=ih*s;
    ctx.drawImage(im,(CW-dw)/2,(CH-dh)/2,dw,dh);
    const g=ctx.createLinearGradient(0,0,0,CH);
    g.addColorStop(0,'rgba(0,0,0,0.30)');
    g.addColorStop(0.55,'rgba(0,0,0,0.18)');
    g.addColorStop(1,'rgba(0,0,0,0.42)');
    ctx.fillStyle=g;ctx.fillRect(0,0,CW,CH);
    return true;
  }
};
async function loadStage(file){
  const ds=document.getElementById('dsS');
  try{
    const n=await Stage.load(file);
    if(ds)ds.textContent=n?`✔ ${n} cenário(s) carregado(s)`:'arquivo inválido';
    if(ds&&n)ds.classList.add('ok');
    if(n)_pushLog(`stage: ${n} imagem(ns) de fundo`);
  }catch(e){if(ds)ds.textContent='erro ao ler cenário';}
}

// ═══════════════════════════════════════════════════════════════
//  v10 · MATCHLOG — registro completo da luta p/ exportar planilha
//  Eventos: GOLPE / BLOQUEIO / WHIFF / TAUNT / PLANO / KO / ROUND
// ═══════════════════════════════════════════════════════════════
const MatchLog={
  ev:[],rounds:[],simTick:0,_roundT0:0,
  _rdmg:{1:0,2:0},_rhits:{1:0,2:0},_rblocks:{1:0,2:0},
  _t(){return +(this.simTick/60).toFixed(2);},
  push(row){this.ev.push(row);if(this.ev.length>60000)this.ev.splice(0,10000);},
  hit(g,atk,def,blocked,dmg,combo){
    const side=atk===g.f1?1:2;
    if(blocked)this._rblocks[side]++;else{this._rdmg[side]+=dmg;this._rhits[side]++;}
    const m=atk.char.moveMap.meta?.[atk.actId]||{};
    this.push({tipo:blocked?'BLOQUEIO':'GOLPE',round:g.roundNo||1,tick:this.simTick,t_s:this._t(),
      atacante:atk.char.name,defensor:def.char.name,golpeId:atk.actId,
      classe:atk.actId>=3000?'hyper':atk.actId>=1000?'special':'normal',
      dano:blocked?0:dmg,danoReal:m.realDamage||dmg,combo:combo||0,
      hpP1:Math.round(g.f1.hp),hpP2:Math.round(g.f2.hp),
      barraP1:Math.round(g.f1.meter),barraP2:Math.round(g.f2.meter),
      planoP1:g.ai1?.plan||'',planoP2:g.ai2?.plan||'',
      prevP1:g.ai1?._predHint?`${g.ai1._predHint.tok}:${g.ai1._predHint.p.toFixed(2)}`:'',
      prevP2:g.ai2?._predHint?`${g.ai2._predHint.tok}:${g.ai2._predHint.p.toFixed(2)}`:''});
  },
  whiff(g,f,id){this.push({tipo:'WHIFF',round:g?.roundNo||1,tick:this.simTick,t_s:this._t(),
    atacante:f.char?.name||'',defensor:'',golpeId:id,classe:id>=3000?'hyper':id>=1000?'special':'normal',
    dano:0,danoReal:0,combo:0,hpP1:g?Math.round(g.f1.hp):0,hpP2:g?Math.round(g.f2.hp):0,
    barraP1:g?Math.round(g.f1.meter):0,barraP2:g?Math.round(g.f2.meter):0,
    planoP1:g?.ai1?.plan||'',planoP2:g?.ai2?.plan||'',prevP1:'',prevP2:''});},
  evt(g,tipo,quem,extra){this.push({tipo,round:g?.roundNo||1,tick:this.simTick,t_s:this._t(),
    atacante:quem||'',defensor:extra||'',golpeId:'',classe:'',dano:0,danoReal:0,combo:0,
    hpP1:g?Math.round(g.f1.hp):0,hpP2:g?Math.round(g.f2.hp):0,
    barraP1:g?Math.round(g.f1.meter):0,barraP2:g?Math.round(g.f2.meter):0,
    planoP1:g?.ai1?.plan||'',planoP2:g?.ai2?.plan||'',prevP1:'',prevP2:''});},
  round(g,winnerSide,winnerName){
    this.rounds.push({round:g.roundNo||1,vencedor:winnerName,lado:winnerSide,
      duracao_s:+(((this.simTick-this._roundT0)/60).toFixed(2)),
      danoP1:Math.round(this._rdmg[1]),danoP2:Math.round(this._rdmg[2]),
      golpesP1:this._rhits[1],golpesP2:this._rhits[2],
      bloqueiosSofridosP1:this._rblocks[2],bloqueiosSofridosP2:this._rblocks[1],
      hpFinalP1:Math.round(g.f1.hp),hpFinalP2:Math.round(g.f2.hp),
      placar:`${g.wins1} x ${g.wins2}`});
    this._roundT0=this.simTick;
    this._rdmg={1:0,2:0};this._rhits={1:0,2:0};this._rblocks={1:0,2:0};
  },
  reset(){this.ev=[];this.rounds=[];this.simTick=0;this._roundT0=0;
    this._rdmg={1:0,2:0};this._rhits={1:0,2:0};this._rblocks={1:0,2:0};}
};
function _sheetFromRows(rows){
  if(typeof XLSX!=='undefined')return XLSX.utils.json_to_sheet(rows.length?rows:[{}]);
  return null;
}
function exportMatchSheet(){
  const g=(typeof game!=='undefined')?game:null;
  if(!g){alert('Inicie uma luta primeiro.');return;}
  // Agregado por golpe (empírico das IAs: acertos × whiffs × dano)
  const golpes=[];
  for(const[ai,f]of[[g.ai1,g.f1],[g.ai2,g.f2]]){
    if(!ai)continue;
    const ids=new Set([...ai.moveHits.keys(),...ai.moveWhiffs.keys()]);
    for(const id of ids){
      const m=f.char.moveMap.meta?.[id]||{};
      const h=ai.moveHits.get(id)||0,w=ai.moveWhiffs.get(id)||0;
      golpes.push({lutador:f.char.name,golpeId:id,
        classe:id>=3000?'hyper':id>=1000?'special':'normal',
        acertos:h,erros:w,precisao:h+w?+((h/(h+w))*100).toFixed(1):0,
        danoBase:m.realDamage||0,provado:ai.provenMoves?.has(id)?'sim':'não'});
    }
  }
  // Snapshot do aprendizado (bandit): valor médio de cada plano por contexto
  const ia=[];
  for(const[ai,f]of[[g.ai1,g.f1],[g.ai2,g.f2]]){
    if(!ai?.bandit)continue;
    for(const[ctx,c]of ai.bandit.ctx){
      for(const p in c.arms){
        const a=c.arms[p];if(a.n<0.5)continue;
        ia.push({lutador:f.char.name,contexto:ctx,plano:p,
          amostras:+a.n.toFixed(1),recompensaMedia:+(a.sum/Math.max(0.001,a.n)).toFixed(3)});
      }
    }
  }
  // v12: snapshot do modelo de confronto e dos contra-estilos
  const matchup=[];
  for(const[ai,f]of[[g.ai1,g.f1],[g.ai2,g.f2]]){
    const mm=ai?.matchup;if(!mm)continue;
    matchup.push({lutador:f.char.name,modo:mm.mode(),winrateEWMA:+mm.wr.toFixed(3),
      powerGap:+mm.powerGap().toFixed(2),dpsProprio:+mm.dpsMe.toFixed(1),dpsRival:+mm.dpsOpp.toFixed(1),
      estiloAtual:mm.style,derrotasSeguidas:mm.lossStreak,reacao:+(ai.reactionVar??0).toFixed(2)});
    if(ai.planner?.net)matchup.push({lutador:f.char.name,modo:'· rede neural',
      winrateEWMA:'',powerGap:'',dpsProprio:'',dpsRival:'',
      estiloAtual:'26→20→6 MLP',derrotasSeguidas:'',reacao:'',
      blocos:ai.planner.net.steps,recompensaMedia:+Math.sqrt(ai.planner.net.lossEwma||0).toFixed(3)});
    if(mm.style==='CUSTOM'&&mm.spsa)matchup.push({lutador:f.char.name,modo:'· spsa θ',
      winrateEWMA:'',powerGap:'',dpsProprio:'',dpsRival:'',
      estiloAtual:mm.spsa.th.map(v=>+v.toFixed(2)).join(' / '),derrotasSeguidas:'',reacao:'',
      blocos:mm.spsa.iter,recompensaMedia:''});
    for(const s in mm.styleStats){
      const a2=mm.styleStats[s];if(!a2.n)continue;
      matchup.push({lutador:f.char.name,modo:'',winrateEWMA:'',powerGap:'',dpsProprio:'',dpsRival:'',
        estiloAtual:'· '+s,derrotasSeguidas:'',reacao:'',
        blocos:+a2.n.toFixed(1),recompensaMedia:+(a2.sum/Math.max(0.001,a2.n)).toFixed(3)});
    }
  }
  const meta=[{exportado:new Date().toLocaleString(),p1:g.c1?.name,p2:g.c2?.name,
    placar:`${g.wins1} x ${g.wins2}`,rounds:g.roundNo||1,
    duracaoSim_s:+((MatchLog.simTick/60).toFixed(1)),eventos:MatchLog.ev.length}];
  try{
    if(typeof XLSX==='undefined')throw new Error('xlsx indisponível');
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(MatchLog.ev),'Eventos');
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(MatchLog.rounds),'Rounds');
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(golpes),'Golpes');
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(ia),'IA_Aprendizado');
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(matchup),'Matchup');
    XLSX.utils.book_append_sheet(wb,_sheetFromRows(meta),'Resumo');
    XLSX.writeFile(wb,`luta_${(g.c1?.name||'p1')}_vs_${(g.c2?.name||'p2')}.xlsx`);
  }catch(e){
    // Fallback CSV (Eventos)
    const rows=MatchLog.ev;if(!rows.length){alert('Sem eventos ainda.');return;}
    const cols=Object.keys(rows[0]);
    const csv=[cols.join(';'),...rows.map(r=>cols.map(c=>String(r[c]??'').replace(/;/g,',')).join(';'))].join('\n');
    const u=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv'}));
    const aEl=document.createElement('a');aEl.href=u;aEl.download='luta_eventos.csv';aEl.click();
    setTimeout(()=>URL.revokeObjectURL(u),5000);
  }
  _pushLog(`planilha exportada: ${MatchLog.ev.length} eventos, ${MatchLog.rounds.length} rounds`);
}
// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const CW=960,CH=540,GROUND=445,GRAVITY=0.62,MIN_Y=60;
// KOF2002 physics reference:
// Normal jump ~38 frames, gravity strong apex, walk/backdash snappy
const SIM_STEP=1000/60;
const WIN_LIMIT=5;  // milestone every 5 wins
const METER_MAX=1000;
const METER_REGEN_IDLE=1.80;
const METER_REGEN_ACTIVE=0.55;
const HP_REGEN_PER_TICK=0.045;
const HP_REGEN_DELAY=170;
let _speedMult=1;   // 1 = normal · unlimited turbo (T key, +/-)
let _lastTurboSpeed=10; // remembered turbo speed for T toggle
let _slomoMult=1;
let _manualMuted=false; // toggled by L key — NOT overridden by speed changes
function _applySpeedAudio(){
  const ico=document.getElementById('mute-ico');
  if(_speedMult>1&&!_globalMuted&&!_manualMuted){
    _globalMuted=true;if(ico)ico.textContent='🔇';
  }else if(_speedMult===1&&_globalMuted&&!_manualMuted){
    _globalMuted=false;if(ico)ico.textContent='🔊';
  }
}
let _logEnabled=false,_logLines=[];
function _uiLine(v){return v===undefined||v===null?'-':String(v);}
function _pushLog(msg){
  const t=new Date();
  const hh=String(t.getHours()).padStart(2,'0'),mm=String(t.getMinutes()).padStart(2,'0'),ss=String(t.getSeconds()).padStart(2,'0');
  _logLines.push(`[${hh}:${mm}:${ss}] ${msg}`);
  if(_logLines.length>80)_logLines.splice(0,_logLines.length-80);
}
function _logPanel(show){
  const p=document.getElementById('log-panel');
  if(p)p.style.display=show?'block':'none';
}

// ═══════════════════════════════════════════════════════════════
//  PCX DECODER
// ═══════════════════════════════════════════════════════════════
const PCX={
  getPal(d){
    if(d.length<769||d[d.length-769]!==0x0C)return null;
    return d.slice(d.length-768);
  },
  // Scan 16-color embedded palette in header (bpp=4 fallback)
  getHeaderPal(d){
    if(d[3]!==8||d[65]!==1)return null; // only for 8bpp 1-plane (d[3]=bits/plane, d[65]=num planes)
    const raw=d.slice(16,16+48); // 16 colours × 3
    if(raw.every(v=>v===0))return null;
    const out=new Uint8Array(768);
    for(let i=0;i<16;i++){out[i*3]=raw[i*3];out[i*3+1]=raw[i*3+1];out[i*3+2]=raw[i*3+2];}
    return out;
  },
  decode(d,extPal){
    if(!d||d.length<128||d[0]!==0x0A)return null;
    const xmax=d[8]|(d[9]<<8),ymax=d[10]|(d[11]<<8),xmin=d[4]|(d[5]<<8),ymin=d[6]|(d[7]<<8);
    const bpl=d[66]|(d[67]<<8),w=xmax-xmin+1,h=ymax-ymin+1;
    if(w<=0||h<=0||w>4000||h>4000)return null;
    const buf=new Uint8Array(Math.max(bpl*h,1));
    let di=0,si=128;
    while(di<buf.length&&si<d.length){
      const b=d[si++];
      if((b&0xC0)===0xC0){const cnt=b&0x3F,val=si<d.length?d[si++]:0,end=Math.min(di+cnt,buf.length);buf.fill(val,di,end);di=end;}
      else if(di<buf.length)buf[di++]=b;
    }
    const pal=extPal||this.getPal(d)||this.getHeaderPal(d);
    const id=new ImageData(w,h);const px=id.data;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const ci=buf[y*bpl+x],p=(y*w+x)*4;
      if(!ci||!pal){px[p+3]=0;continue;}
      px[p]=pal[ci*3];px[p+1]=pal[ci*3+1];px[p+2]=pal[ci*3+2];px[p+3]=255;
    }
    return{id,w,h};
  }
};


// ═══════════════════════════════════════════════════════════════
//  SND PARSER — MUGEN sound archive (.snd)
//  Entry layout: next(4) + dlen(4) + grp(2) + idx(2) + name(12) + WAV(dlen) = header 24 bytes
// ═══════════════════════════════════════════════════════════════
async function parseSND(buf){
  const dv=new DataView(buf);
  const sig=String.fromCharCode(...new Uint8Array(buf,0,11));
  if(!sig.startsWith('ElecbyteSnd'))return null;
  let ofs=dv.getUint32(20,true);
  // grp → AudioBuffer[]  (multiple sounds per group = random pick)
  const raw=new Map(); // grp → ArrayBuffer[]
  for(let iter=0;iter<4000&&ofs>0&&ofs+16<=buf.byteLength;iter++){
    const nxt =dv.getUint32(ofs,true);
    const dlen=dv.getUint32(ofs+4,true);
    const grp =dv.getUint16(ofs+8,true);
    // WAV data starts at ofs+16: next(4)+dlen(4)+grp(2)+snd(2)+reserved(4) = 16 bytes
    // Confirmed by binary inspection: RIFF signature at entry+16
    const wavOfs=ofs+16;
    if(dlen>0&&wavOfs+dlen<=buf.byteLength){
      if(!raw.has(grp))raw.set(grp,[]);
      // Slice the WAV bytes (complete RIFF file)
      raw.get(grp).push(buf.slice(wavOfs,wavOfs+dlen));
    }
    if(!nxt)break;
    ofs=nxt;
  }
  return raw; // Map<grp, ArrayBuffer[]>
}

// ═══════════════════════════════════════════════════════════════
//  SOUND PLAYER — Web Audio wrapper with per-character context
// ═══════════════════════════════════════════════════════════════
class SoundPlayer{
  constructor(){
    this._ctx=null;
    this._bufs=new Map(); // grp → AudioBuffer[]
    this._muted=false;
    this._lastPlay=new Map(); // grp → ts (debounce same-group spam)
  }
  // Call once after parseSND returns raw map
  async load(rawMap){
    if(!rawMap)return;
    try{
      if(!this._ctx)this._ctx=new(window.AudioContext||window.webkitAudioContext)();
      for(const[grp,bufs]of rawMap){
        const decoded=[];
        for(const ab of bufs){
          try{
            const buf=await this._ctx.decodeAudioData(ab.slice(0));
            decoded.push(buf);
          }catch(e){/* skip bad WAV */}
        }
        if(decoded.length)this._bufs.set(grp,decoded);
      }
      // Remap non-standard groups to conventional slots 0,1,2,5
      // so chars that use action-ID-matched SND groups still produce audio.
      const std=[0,1,2,5];
      const hasStd=std.some(g=>this._bufs.has(g));
      if(!hasStd&&this._bufs.size>0){
        const avail=[...this._bufs.keys()].sort((a,b)=>a-b);
        // group 0 → first available (smallest grp = likely pain/voice grunt)
        if(!this._bufs.has(0)) this._bufs.set(0, this._bufs.get(avail[0]));
        // group 1 → second available
        if(!this._bufs.has(1)&&avail.length>1) this._bufs.set(1, this._bufs.get(avail[1]));
        // group 2 → group with most sounds (SFX pool)
        if(!this._bufs.has(2)){
          const bigGrp=avail.reduce((a,b)=>this._bufs.get(b).length>this._bufs.get(a).length?b:a);
          this._bufs.set(2, this._bufs.get(bigGrp));
        }
        // group 5 (KO) → first group >= 5000, or last group
        if(!this._bufs.has(5)){
          const koGrp=avail.find(g=>g>=5000)??avail[avail.length-1];
          this._bufs.set(5, this._bufs.get(koGrp));
        }
      }
    }catch(e){console.warn('SoundPlayer init failed:',e.message);}
  }
  // Resume context on first user interaction (browser autoplay policy)
  resume(){if(this._ctx&&this._ctx.state==='suspended')this._ctx.resume();}
  play(grp,vol=0.9,debounceMs=40){
    if(_globalMuted||this._muted||!this._ctx||!this._bufs.has(grp))return;
    const now=performance.now();
    if((this._lastPlay.get(grp)||0)+debounceMs>now)return; // debounce same group
    this._lastPlay.set(grp,now);
    const bufs=this._bufs.get(grp);
    const buf=bufs[Math.random()*bufs.length|0];
    try{
      const src=this._ctx.createBufferSource();
      const gain=this._ctx.createGain();
      src.buffer=buf;
      gain.gain.value=Math.min(1,vol);
      src.connect(gain);gain.connect(this._ctx.destination);
      src.start();
    }catch(e){}
  }
  // Convenience aliases matching MUGEN group conventions
  // grp 0 = hit/pain voice, grp 1 = attack voice, grp 2 = punch SFX
  // grp 3-6 = special SFX, grp 5 = KO
  playHit(vol=0.85)    {this.play(0,vol,60);}   // voice when taking damage
  playAtk(vol=0.80)    {this.play(1,vol,80);}   // voice when attacking
  playPunch(vol=0.75)  {this.play(2,vol,30);}   // punch/kick impact SFX
  playSpecial(vol=0.85){this.play(3,vol,120);}  // special move SFX
  playTaunt(vol=0.78)  {this.play(this._bufs.has(2)?2:1,vol,220);} // taunt / gesture voice
  playKO(vol=1.0)      {this.play(5,vol,500);}  // KO voice
}

// Shared AudioContext for hit sparks (doesn't depend on character)
let _sfxCtx=null;
let _globalMuted=false;  // toggled by L key — affects all audio
function _getCtx(){if(!_sfxCtx)try{_sfxCtx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}return _sfxCtx;}
function playSynthHit(big=false){
  if(_globalMuted)return;
  // Synthesize a short percussive "thwack" with Web Audio when no SND loaded
  const ctx=_getCtx();if(!ctx)return;
  try{
    const g=ctx.createGain();g.connect(ctx.destination);
    g.gain.setValueAtTime(big?0.5:0.28,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+(big?0.18:0.09));
    const o=ctx.createOscillator();o.type='sawtooth';
    o.frequency.setValueAtTime(big?280:420,ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(big?60:80,ctx.currentTime+(big?0.18:0.09));
    o.connect(g);o.start();o.stop(ctx.currentTime+(big?0.20:0.12));
    // Noise layer
    const bufN=ctx.createBuffer(1,ctx.sampleRate*(big?0.12:0.06),ctx.sampleRate);
    const bd=bufN.getChannelData(0);for(let i=0;i<bd.length;i++)bd[i]=(Math.random()*2-1);
    const gN=ctx.createGain();gN.gain.setValueAtTime(big?0.35:0.18,ctx.currentTime);
    gN.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+(big?0.12:0.06));
    const sN=ctx.createBufferSource();sN.buffer=bufN;sN.connect(gN);gN.connect(ctx.destination);sN.start();
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════════
//  SFF PARSER v1
// ═══════════════════════════════════════════════════════════════
async function parseSFFv1(buf,dv,actPal){
  const total=dv.getUint32(20,true);
  let ofs=dv.getUint32(24,true);
  // hdrSz at byte 28 = size of each sprite SUB-HEADER (always 32 in SFF v1).
  // Some chars store the FILE header size (512) here by mistake → clamp to [28,64].
  const rawHdrSz=dv.getUint16(28,true);
  const hdrSz=(rawHdrSz>=28&&rawHdrSz<=64)?rawHdrSz:32;
  const palType=dv.getUint8(30);
  const sprites=new Map(),list=[],pals=[];
  let sharedPal=null;
  for(let idx=0;idx<total&&ofs>0&&ofs+hdrSz<=buf.byteLength;idx++){
    const nextOfs=dv.getUint32(ofs,true),dlen=dv.getUint32(ofs+4,true);
    const ax=dv.getInt16(ofs+8,true),ay=dv.getInt16(ofs+10,true);
    const grp=dv.getUint16(ofs+12,true),img=dv.getUint16(ofs+14,true);
    const lnkIdx=dv.getUint16(ofs+16,true),samePal=dv.getUint8(ofs+18);
    let cvs=null,pal=null;
    if(dlen>0&&ofs+hdrSz+dlen<=buf.byteLength){
      const pcx=new Uint8Array(buf,ofs+hdrSz,dlen);
      if(samePal&&lnkIdx<pals.length&&pals[lnkIdx]) pal=pals[lnkIdx];
      else pal=PCX.getPal(pcx)||actPal;
      if(palType===1){if(idx===0&&pal)sharedPal=pal;if(sharedPal)pal=sharedPal;}
      pals[idx]=pal;
      const dec=PCX.decode(pcx,pal);
      if(dec){cvs=document.createElement('canvas');cvs.width=dec.w;cvs.height=dec.h;cvs.getContext('2d').putImageData(dec.id,0,0);}
    }else if(!dlen&&lnkIdx<list.length&&list[lnkIdx]){
      cvs=list[lnkIdx].cvs;
      pals[idx]=pals[lnkIdx]||null;
    }
    list[idx]={cvs,ax,ay};
    if(cvs)sprites.set(`${grp},${img}`,{cvs,ax,ay});
    if(!nextOfs)break;
    ofs=nextOfs;
  }
  return sprites;
}

// ═══════════════════════════════════════════════════════════════
//  SFF PARSER v2
// ═══════════════════════════════════════════════════════════════
async function parseSFFv2(buf,dv,actPal){
  const sprites=new Map();
  let sprOfs=dv.getUint32(36,true),numSpr=dv.getUint32(40,true),palOfs=dv.getUint32(44,true),numPal=dv.getUint32(48,true);
  if(sprOfs>buf.byteLength||sprOfs<32){sprOfs=dv.getUint32(28,true);numSpr=dv.getUint32(32,true);palOfs=dv.getUint32(20,true);numPal=dv.getUint32(24,true);}
  const pals=[];
  for(let i=0;i<numPal&&palOfs+16<=buf.byteLength;i++){
    const lnk=dv.getUint16(palOfs+6,true),dofs=dv.getUint32(palOfs+8,true),dlen=dv.getUint32(palOfs+12,true);
    pals.push(lnk>0&&lnk<pals.length?pals[lnk]:(dofs>0&&dofs+dlen<=buf.byteLength?new Uint8Array(buf,dofs,Math.min(dlen,768)):(actPal||null)));
    palOfs+=16;
  }
  const recs=[];
  for(let i=0;i<numSpr&&sprOfs+28<=buf.byteLength;i++){
    recs.push({grp:dv.getUint16(sprOfs,true),img:dv.getUint16(sprOfs+2,true),w:dv.getUint16(sprOfs+4,true),h:dv.getUint16(sprOfs+6,true),ax:dv.getInt16(sprOfs+8,true),ay:dv.getInt16(sprOfs+10,true),lnk:dv.getUint16(sprOfs+12,true),fmt:dv.getUint8(sprOfs+14),cd:dv.getUint8(sprOfs+15),dofs:dv.getUint32(sprOfs+16,true),dlen:dv.getUint32(sprOfs+20,true),palI:dv.getUint16(sprOfs+24,true)});
    sprOfs+=28;
  }
  for(let i=0;i<recs.length;i++){
    const r=recs[i],key=`${r.grp},${r.img}`;
    if(!r.dlen&&r.lnk>0&&r.lnk<recs.length){const lk=recs[r.lnk],lkKey=`${lk.grp},${lk.img}`;if(sprites.has(lkKey)){sprites.set(key,{...sprites.get(lkKey),ax:r.ax,ay:r.ay});continue;}}
    if(!r.dlen||!r.dofs||r.dofs+r.dlen>buf.byteLength)continue;
    const data=new Uint8Array(buf,r.dofs,r.dlen);
    try{
      if(r.fmt===10){
        // PNG
        const bmp=await createImageBitmap(new Blob([data],{type:'image/png'}));
        const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);
        sprites.set(key,{cvs:c,ax:r.ax,ay:r.ay});
      }else if(r.fmt===2&&r.w>0&&r.h>0){
        // RLE8 — uncompress then palette map
        const out=new Uint8Array(r.w*r.h);
        let di=0,si=0;
        while(di<out.length&&si<data.length){
          const ctrl=data[si++];
          if(ctrl===0){const n=si<data.length?data[si++]:0;if(n===0)break;if(n===1)break;if(n===2){si+=2;continue;}for(let k=0;k<n&&di<out.length&&si<data.length;k++)out[di++]=data[si++];if(n%2)si++;}
          else{const v=si<data.length?data[si++]:0;for(let k=0;k<ctrl&&di<out.length;k++)out[di++]=v;}
        }
        const pal=pals[r.palI]||actPal;if(!pal)continue;
        const id=new ImageData(r.w,r.h);const px=id.data;
        for(let p=0;p<r.w*r.h;p++){const ci=out[p];if(!ci){px[p*4+3]=0;continue;}px[p*4]=pal[ci*3];px[p*4+1]=pal[ci*3+1];px[p*4+2]=pal[ci*3+2];px[p*4+3]=255;}
        const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').putImageData(id,0,0);
        sprites.set(key,{cvs:c,ax:r.ax,ay:r.ay});
      }else if(r.fmt===0&&r.cd===0&&r.w>0&&r.h>0){
        // RAW indexed
        const pal=pals[r.palI]||actPal;if(!pal)continue;
        const id=new ImageData(r.w,r.h);const px=id.data;
        for(let p=0;p<r.w*r.h;p++){const ci=data[p]||0;if(!ci){px[p*4+3]=0;continue;}px[p*4]=pal[ci*3];px[p*4+1]=pal[ci*3+1];px[p*4+2]=pal[ci*3+2];px[p*4+3]=255;}
        const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').putImageData(id,0,0);
        sprites.set(key,{cvs:c,ax:r.ax,ay:r.ay});
      }else if(r.fmt===0&&r.cd===1&&r.w>0&&r.h>0){
        // LZ5 — Elecbyte custom LZSS variant used in SFF v2
        // Reference: https://wiki.mugen.com/sff-v2
        const out=new Uint8Array(r.w*r.h);
        let di=0,si=0;
        while(di<out.length&&si<data.length){
          const flags=data[si++];
          for(let bit=0;bit<8&&di<out.length&&si<data.length;bit++){
            if(flags&(1<<bit)){
              // Literal byte
              out[di++]=data[si++];
            }else{
              // Back-reference: 2 bytes
              if(si+1>=data.length)break;
              const lo=data[si++],hi=data[si++];
              const dist=lo|((hi&0xF0)<<4);
              const len=(hi&0x0F)+3;
              if(dist===0){di+=len;continue;}
              for(let k=0;k<len&&di<out.length;k++){
                out[di]=di>=dist?out[di-dist]:0;di++;
              }
            }
          }
        }
        const pal=pals[r.palI]||actPal;if(!pal)continue;
        const id=new ImageData(r.w,r.h);const px=id.data;
        for(let p=0;p<r.w*r.h;p++){const ci=out[p];if(!ci){px[p*4+3]=0;continue;}px[p*4]=pal[ci*3];px[p*4+1]=pal[ci*3+1];px[p*4+2]=pal[ci*3+2];px[p*4+3]=255;}
        const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').putImageData(id,0,0);
        sprites.set(key,{cvs:c,ax:r.ax,ay:r.ay});
      }
    }catch(e){}
  }
  return sprites;
}

async function parseSFF(buf,actPal){
  const sig=String.fromCharCode(...new Uint8Array(buf,0,12));
  if(!sig.startsWith('ElecbyteSpr'))throw new Error('SFF inválido');
  const dv=new DataView(buf);
  // Version stored as [ver3,ver2,ver1,ver0] at bytes 12-15.
  // Major version (ver0) is at byte 15. Some files also use byte 13.
  // e.g. Yuri-EX: bytes12-15=[0,1,0,2] → ver0=2 → SFF v2.01
  const isV2 = dv.getUint8(15)>=2 || dv.getUint8(13)>=2;
  return isV2 ? parseSFFv2(buf,dv,actPal) : parseSFFv1(buf,dv,actPal);
}

// ═══════════════════════════════════════════════════════════════
//  AIR PARSER
// ═══════════════════════════════════════════════════════════════
function parseAIR(text){
  const actions=new Map();let cur=null,frames=[],loopStarts=new Map();
  let defClsn1=[],defClsn2=[],curClsn1=[],curClsn2=[];
  let mode=0,modeDefault=false;
  const cloneBoxes=a=>a.map(b=>({x1:b.x1,y1:b.y1,x2:b.x2,y2:b.y2}));
  const resetFrameClsns=()=>{curClsn1=[];curClsn2=[];mode=0;modeDefault=false;};
  for(const raw of text.split('\n')){
    const ci=raw.indexOf(';');
    const line=(ci>=0?raw.slice(0,ci):raw).trim();if(!line)continue;
    if(/^\[begin action\s*\d+\]/i.test(line)){
      if(cur!==null)actions.set(cur,frames);
      const m=line.match(/action\s+(\d+)/i);
      cur=m?parseInt(m[1]):null;frames=[];defClsn1=[];defClsn2=[];resetFrameClsns();
    }else if(/^\[end action\]/i.test(line)){
      if(cur!==null)actions.set(cur,frames);cur=null;frames=[];defClsn1=[];defClsn2=[];resetFrameClsns();
    }else if(cur!==null&&/^loopstart$/i.test(line)){
      loopStarts.set(cur,frames.length);
    }else if(cur!==null&&( /^clsn([12])default\s*:\s*\d+/i.test(line) || /^clsn([12])\s*:\s*\d+/i.test(line) )){
      const m=line.match(/^clsn([12])(default)?\s*:\s*\d+/i);
      mode=parseInt(m[1]);modeDefault=!!m[2];
      if(modeDefault){ if(mode===1)defClsn1=[]; else defClsn2=[]; }
      else{ if(mode===1)curClsn1=[]; else curClsn2=[]; }
    }else if(cur!==null&&/^clsn([12])\[\d+\]\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i.test(line)){
      const m=line.match(/^clsn([12])\[\d+\]\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i);
      const box={x1:parseInt(m[2]),y1:parseInt(m[3]),x2:parseInt(m[4]),y2:parseInt(m[5])};
      const kind=parseInt(m[1]);
      if(modeDefault){ if(kind===1)defClsn1.push(box); else defClsn2.push(box); }
      else if(mode===kind){ if(kind===1)curClsn1.push(box); else curClsn2.push(box); }
      else { if(kind===1)curClsn1.push(box); else curClsn2.push(box); }
    }else if(cur!==null&&/^-?\d/.test(line)){
      const p=line.split(',').map(s=>s.trim());
      if(p.length>=5){
        const g=parseInt(p[0]),i=parseInt(p[1]);
        if(isNaN(g)||isNaN(i))continue;
        const ox=parseInt(p[2])||0,oy=parseInt(p[3])||0;
        let del=parseInt(p[4]);if(isNaN(del))del=4;
        const fl=(p.slice(5).join('')).toUpperCase();
        frames.push({
          g,i,ox,oy,delay:del,flipH:fl.includes('H'),
          clsn1:curClsn1.length?cloneBoxes(curClsn1):cloneBoxes(defClsn1),
          clsn2:curClsn2.length?cloneBoxes(curClsn2):cloneBoxes(defClsn2)
        });
        resetFrameClsns();
      }
    }
  }
  if(cur!==null)actions.set(cur,frames);
  for(const[id,ls]of loopStarts){const frs=actions.get(id);if(frs)frs.loopStart=ls;}
  return actions;
}

// ═══════════════════════════════════════════════════════════════
//  LOAD LOOSE IMAGES (non-MUGEN zips with PNG/GIF/BMP/JPG)
// ═══════════════════════════════════════════════════════════════
async function loadLooseImages(byExt){
  const sprites=new Map();
  const imgExts=['png','gif','bmp','jpg','jpeg'];
  let idx=0;
  for(const ext of imgExts){
    for(const entry of(byExt[ext]||[])){
      try{
        const ab=await entry.f.async('arraybuffer');
        const mime=ext==='jpg'||ext==='jpeg'?'image/jpeg':`image/${ext}`;
        const bmp=await createImageBitmap(new Blob([ab],{type:mime}));
        const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
        c.getContext('2d').drawImage(bmp,0,0);
        const ax=Math.floor(bmp.width/2),ay=bmp.height;
        sprites.set(`0,${idx}`,{cvs:c,ax,ay});
        idx++;
      }catch(e){}
    }
  }
  return sprites;
}

// ═══════════════════════════════════════════════════════════════
//  SYNTHESIZE ANIMATIONS from sprite list (non-MUGEN fallback)
// ═══════════════════════════════════════════════════════════════
function synthesizeAnims(sprites){
  const anims=new Map();
  const keys=[...sprites.keys()].map(k=>{const[g,i]=k.split(',').map(Number);return{g,i};}).sort((a,b)=>a.g-b.g||a.i-b.i);
  if(!keys.length)return anims;
  // Group by group id
  const byG=new Map();
  for(const{g,i}of keys){if(!byG.has(g))byG.set(g,[]);byG.get(g).push(i);}
  const groups=[...byG.keys()].sort((a,b)=>a-b);
  const makeAnim=(id,items,delay=4,loop=false)=>{
    const frs=items.map(([g,i])=>({g,i,ox:0,oy:0,delay,flipH:false}));
    if(loop)frs.loopStart=0;
    anims.set(id,frs);
  };
  if(groups.length===1&&groups[0]===0){
    // Single group — split by image count
    const imgs=byG.get(0);const n=imgs.length;
    const s1=Math.max(1,Math.floor(n*0.15)),s2=Math.max(s1+1,Math.floor(n*0.30));
    const s3=Math.max(s2+1,Math.floor(n*0.55));
    makeAnim(0,imgs.slice(0,s1).map(i=>[0,i]),6,true);
    if(s2>s1)makeAnim(20,imgs.slice(s1,s2).map(i=>[0,i]),4,true);
    if(s3>s2)makeAnim(200,imgs.slice(s2,s3).map(i=>[0,i]),3,false);
    if(n>s3)makeAnim(5000,imgs.slice(s3).map(i=>[0,i]),4,true);
  }else{
    // Multiple groups — assign by size heuristic
    const sorted=[...byG.entries()].map(([g,imgs])=>({g,imgs,n:imgs.length})).sort((a,b)=>a.n-b.n);
    const actionIds=[0,20,21,40,200,210,220,400,1000,1010,5000,5100];
    sorted.forEach(({g,imgs},idx)=>{
      const actionId=actionIds[idx]??(2000+idx*10);
      const items=imgs.map(i=>[g,i]);
      makeAnim(actionId,items,4,actionId<200);
    });
  }
  return anims;
}

// ═══════════════════════════════════════════════════════════════
//  MOVE MAP — MUGEN primary + adaptive fallback
// ═══════════════════════════════════════════════════════════════
function animDuration(frs){
  return frs.reduce((s,f)=>s+Math.max(1,f.delay<0?8:f.delay),0);
}

function analyzeAnim(frs){
  const unique=new Set();
  let visible=0,clsn1Frames=0,clsn2Frames=0,firstActive=-1,lastActive=-1,totalDelay=0,motion=0;
  for(let i=0;i<frs.length;i++){
    const f=frs[i]||{};
    unique.add(`${f.g},${f.i}`);
    if(Number.isFinite(f.g)&&Number.isFinite(f.i))visible++;
    if(f.clsn1?.length){clsn1Frames++;if(firstActive<0)firstActive=i;lastActive=i;}
    if(f.clsn2?.length)clsn2Frames++;
    totalDelay+=Math.max(1,Math.abs(f.delay||0));
    motion+=Math.abs(f.ox||0)+Math.abs(f.oy||0);
  }
  const activeSpan=firstActive>=0?Math.max(1,lastActive-firstActive+1):0;
  const score=
    (clsn1Frames?7:0)+
    Math.min(3.5,unique.size*0.7)+
    Math.min(3,motion/36)+
    Math.min(2.5,totalDelay/22)+
    (frs.loopStart===undefined?1.2:-2.2);
  return{
    visibleFrames:visible,uniqueSprites:unique.size,clsn1Frames,clsn2Frames,
    hasClsn1:clsn1Frames>0,hasClsn2:clsn2Frames>0,firstActive,lastActive,activeSpan,
    totalDelay,motion,score,
    usable:(frs.loopStart===undefined)&&(visible>0)&&(unique.size>=1)
  };
}

function buildMoveMap(anims,hitDefsByAnim,cmdInfo,stateCatalog){
  const mm={stand:[],walkF:[],walkB:[],runF:[],runB:[],crouch:[],jump:[],atkStand:[],atkCrouch:[],atkAir:[],specials:[],hypers:[],ko:[],intros:[],winPoses:[],hit:[],fall:[],taunts:[],meta:{},routes:[],families:new Map(),signatures:{normals:[],crouch:[],air:[],specials:[],hypers:[],antiAir:[],projectiles:[],rush:[],mobility:[],starters:[],enders:[],taunts:[]}};
  const add=(key,id)=>{if(id!==undefined&&id!==null&&!mm[key].includes(id))mm[key].push(id);};
  const specialStates=cmdInfo?.specialStates||new Set();
  const hyperStates=cmdInfo?.hyperStates||new Set();
  const tauntStates=cmdInfo?.tauntStates||new Set();
  const commandByState=cmdInfo?.commandByState||new Map();
  const stateByNo=stateCatalog?.byState||new Map();
  const familyByAnim=stateCatalog?.familyByAnim||new Map();
  const scoreMove=(id)=>{
    const m=mm.meta[id]||{};
    let s=(m.score||0);
    if(m.hasHitDef)s+=3.6;
    if((m.realDamage||0)>0)s+=Math.min(6,(m.realDamage||0)/16);
    if((m.multiCount||0)>1)s+=1.1;
    if(m.hasClsn1)s+=0.8;
    if(m.fromCommand==='special')s+=2.2;
    if(m.fromCommand==='hyper')s+=3.0;
    if(m.usable===false)s-=99;
    return s;
  };
  for(const[id,frs]of anims){
    if(!frs.length)continue;
    const dur=animDuration(frs),hasLoop=frs.loopStart!==undefined;
    const meta=analyzeAnim(frs);
    const hitSpec=hitDefsByAnim?.get(id)||null;
    const stateNo=hitSpec?.stateNo ?? (stateCatalog?.byAnim?.get(id)?.[0]?.stateNo ?? null);
    const stateInfo=(stateNo!==undefined&&stateNo!==null)?stateByNo.get(stateNo):null;
    const cmdDef=(stateNo!==undefined&&stateNo!==null)?commandByState.get(stateNo):null;
    const stateTitle=stateInfo?.title||'';
    const family=familyByAnim.get(id)||stateInfo?.family||'';
    const looksTaunt=(cmdDef?.name||stateTitle||'').match(/taunt|provoc|intro|pose|beckon|come on|c'mon/i);
    // v10: classifica intro/win pose pelo título do statedef
    if(/intro/i.test(stateTitle)&&!mm.intros.includes(id))mm.intros.push(id);
    if(/win|victory|vit[oó]ria/i.test(stateTitle)&&!mm.winPoses.includes(id))mm.winPoses.push(id);
    const fromCommand=hyperStates.has(stateNo)?'hyper':(specialStates.has(stateNo)?'special':(looksTaunt||tauntStates.has(stateNo)?'taunt':null));
    meta.hitSpec=hitSpec;
    meta.hasHitDef=!!hitSpec;
    meta.realDamage=hitSpec?.damage||0;
    meta.guardDamage=hitSpec?.guardDamage??0;
    meta.multiCount=hitSpec?.multiCount||1;
    meta.attr=(hitSpec?.attr||'').toUpperCase();
    meta.guardflag=(hitSpec?.guardflag||'').toUpperCase();
    meta.isProjectile=!!hitSpec?.isProjectile;
    meta.stateNo=stateNo;
    meta.fromCommand=fromCommand;
    meta.commandName=cmdDef?.name||'';
    meta.stateTitle=stateTitle;
    meta.family=family;
    meta.comboWeight=(meta.realDamage||0)+(meta.multiCount>1?14:0)+(meta.hasHitDef?10:0)+(meta.hasClsn1?4:0)+(fromCommand==='hyper'?18:fromCommand==='special'?10:fromCommand==='taunt'?-16:0)-Math.max(0,dur-30)*0.42;
    mm.meta[id]={...meta,dur};
    if(family){if(!mm.families.has(family))mm.families.set(family,[]);mm.families.get(family).push(id);}
    const strikeLike=!!hitSpec||meta.hasClsn1||(!meta.hasClsn2&&!hasLoop&&meta.score>=6.6&&dur>=10);
    const moveLike=!hasLoop&&meta.score>=4.6&&dur>=8;
    const forcedSpecial=fromCommand==='special';
    const forcedHyper=fromCommand==='hyper';

    if(id===0||(id>=1&&id<=6)) add('stand',id);
    else if(id>=7&&id<=19) add('crouch',id);
    else if(id===20||id===22||id===24) add('walkF',id);
    else if(id===21||id===23||id===25) add('walkB',id);
    else if(id>=40&&id<=79) add('jump',id);
    else if(id===100&&hasLoop) add('crouch',id);
    else if(fromCommand!== 'taunt' && /(^|\b)(run|dash|step|forward dash|run f|ff|66|rush|advance|forward run)(\b|$)/i.test(`${meta.commandName} ${meta.stateTitle} ${family}`)) add('runF',id);
    else if(fromCommand!== 'taunt' && /(^|\b)(back dash|backdash|back step|retreat|hop back|back hop|run b|bb|44|back run|backstep|evade)(\b|$)/i.test(`${meta.commandName} ${meta.stateTitle} ${family}`)) add('runB',id);
    else if(id>=101&&id<=119){}
    else if(fromCommand==='taunt' || (!hitSpec&&!meta.hasClsn1&&!meta.hasClsn2&&dur>=12&&dur<=80&&/taunt|provoc|beckon|pose/i.test(`${meta.commandName} ${meta.stateTitle}`))) add('taunts',id);
    else if(forcedHyper) add('hypers',id);
    else if(forcedSpecial) add('specials',id);
    else if(id>=120&&id<=169&&!hasLoop&&strikeLike) add('atkStand',id);
    else if(id>=170&&id<=199&&!hasLoop&&(meta.hasClsn1||moveLike)) add('atkAir',id);
    else if(id>=200&&id<=299&&strikeLike) add('atkStand',id);
    else if(id>=300&&id<=599&&strikeLike) add('atkCrouch',id);
    else if(id>=600&&id<=899&&(meta.hasClsn1||moveLike)) add('atkAir',id);
    else if(id>=1000&&id<=2999&&!hasLoop&&((!!hitSpec)||meta.hasClsn1||meta.score>=7.2)&&dur>=6) add('specials',id);
    else if(id>=3000&&id<=4999&&!hasLoop&&((!!hitSpec)||meta.hasClsn1||meta.score>=8.2)&&dur>=8) add('hypers',id);
    else if(id>=5000&&id<=5059) add('hit',id);
    else if(id>=5060&&id<=5099) add('fall',id);
    else if(id>=5100&&id<=5300) add('ko',id);
  }

  const used=new Set([...mm.stand,...mm.walkF,...mm.walkB,...mm.crouch,...mm.jump,...mm.atkStand,...mm.atkCrouch,...mm.atkAir,...mm.specials,...mm.hypers,...mm.hit,...mm.fall,...mm.ko]);
  const rem=[...anims.keys()].filter(id=>!used.has(id)&&anims.get(id)?.length).sort((a,b)=>scoreMove(b)-scoreMove(a)||(a-b));

  if(!mm.stand.length){
    const cand=rem.find(id=>anims.get(id).loopStart!==undefined)||[...anims.keys()][0]||0;
    add('stand',cand);
  }
  if(!mm.walkF.length){
    // BUG FIX #1/#2: encontrar animação com loop que NÃO seja stand/ataque.
    // Usar stand como walk faz o personagem deslizar (move fisicamente mas exibe pose parada).
    // Prioridade: (1) ID canônico de walk (20-39) com loop,
    //             (2) qualquer looping não-ataque, não-stand, não-crouch com ≥3 frames,
    //             (3) stand como último recurso.
    const attackSet=new Set([...mm.atkStand,...mm.atkCrouch,...mm.atkAir,...mm.specials,...mm.hypers]);
    const loopCands=[...anims.entries()].filter(([id,frs])=>
      frs.loopStart!==undefined&&frs.length>=3&&
      !mm.stand.includes(id)&&!mm.crouch.includes(id)&&!mm.jump.includes(id)&&
      !attackSet.has(id)&&!mm.hit.includes(id)&&!mm.ko.includes(id)
    );
    const canonical=loopCands.filter(([id])=>id>=20&&id<40);
    const chosen=(canonical.length?canonical:loopCands).sort((a,b)=>b[1].length-a[1].length);
    add('walkF',chosen.length?chosen[0][0]:mm.stand[0]);
  }
  if(!mm.walkB.length){
    // walkB: reutilizar walkF se não for stand (flip horizontal cuida do sentido visual)
    const wf=mm.walkF[0];
    add('walkB',(wf!==undefined&&!mm.stand.includes(wf))?wf:mm.stand[0]);
  }
  if(!mm.runF.length) for(const id of [...mm.specials,...mm.atkStand].filter(id=>/run|dash|step|66|rush|advance/i.test(`${mm.meta[id]?.commandName||''} ${mm.meta[id]?.stateTitle||''} ${mm.meta[id]?.family||''}`)).slice(0,3)) add('runF',id);
  if(!mm.runB.length) for(const id of [...mm.specials,...mm.atkStand].filter(id=>/back dash|backdash|back step|hop back|back hop|44|backstep|retreat|evade/i.test(`${mm.meta[id]?.commandName||''} ${mm.meta[id]?.stateTitle||''} ${mm.meta[id]?.family||''}`)).slice(0,2)) add('runB',id);
  if(!mm.runF.length) add('runF',mm.walkF[0]);
  if(!mm.runB.length) add('runB',mm.walkB[0]);
  if(!mm.jump.length){
    const cand=rem.find(id=>id>=40&&id<120)||mm.stand[0];
    add('jump',cand);
  }
  if(!mm.hit.length) add('hit',mm.stand[0]);
  if(!mm.ko.length) add('ko',mm.hit[0]??mm.stand[0]);

  const nonNeutral=rem.filter(id=>{
    const m=mm.meta[id];
    return m.usable&&((m.hasHitDef&&m.realDamage>0)||(m.hasClsn1&&m.score>=5.4)||(m.score>=7.2&&m.dur>=7)||(m.fromCommand==='special')||(m.fromCommand==='hyper'))&&anims.get(id).loopStart===undefined;
  });

  if(!mm.atkStand.length){ for(const id of nonNeutral.filter(id=>id<1000).slice(0,8)) add('atkStand',id); }
  if(!mm.atkCrouch.length){ for(const id of nonNeutral.filter(id=>id>=300&&id<600).slice(0,5)) add('atkCrouch',id); }
  if(!mm.atkAir.length){ for(const id of nonNeutral.filter(id=>id>=600&&id<900).slice(0,5)) add('atkAir',id); }
  if(!mm.specials.length){ for(const id of nonNeutral.filter(id=>mm.meta[id]?.fromCommand==='special'||(id>=900&&id<3000)).slice(0,8)) add('specials',id); }
  if(!mm.hypers.length){ for(const id of nonNeutral.filter(id=>mm.meta[id]?.fromCommand==='hyper'||(id>=3000&&id<5000)).slice(0,5)) add('hypers',id); }
  if(!mm.atkStand.length) add('atkStand',mm.stand[0]);

  const byMove=(arr,n=6)=>[...new Set(arr)].sort((a,b)=>scoreMove(b)-scoreMove(a)||a-b).slice(0,n);
  // v10: intros (anim 190-199) e poses de vitória (180-189) — convenção MUGEN
  for(let id=190;id<=199;id++)if(anims.has(id)&&!mm.intros.includes(id))mm.intros.push(id);
  for(let id=180;id<=189;id++)if(anims.has(id)&&!mm.winPoses.includes(id))mm.winPoses.push(id);
  mm.signatures.normals=byMove(mm.atkStand,8);
  mm.signatures.crouch =byMove(mm.atkCrouch,5);
  mm.signatures.air    =byMove(mm.atkAir,5);
  mm.signatures.specials=byMove(mm.specials.filter(id=>!mm.meta[id]?.isProjectile),5);
  if(!mm.signatures.specials.length)mm.signatures.specials=byMove(mm.specials,5);
  mm.signatures.hypers =byMove(mm.hypers,3);

  const normalPool=byMove([...mm.atkStand,...mm.atkCrouch],12);
  const starters=normalPool.filter(id=>{
    const m=mm.meta[id]||{};
    return (m.realDamage||0)<=45 && (m.dur||0)<=22;
  });
  const linkers=normalPool.filter(id=>{
    const m=mm.meta[id]||{};
    return (m.realDamage||0)>20 && (m.realDamage||0)<=70 && (m.dur||0)<=28;
  });
  const enders=byMove([...mm.atkStand,...mm.atkCrouch,...mm.specials,...mm.hypers],12).filter(id=>(mm.meta[id]?.realDamage||0)>0||mm.meta[id]?.hasHitDef||id>=1000);
  mm.signatures.starters=starters.slice(0,5).length?starters.slice(0,5):mm.signatures.normals.slice(0,4);
  mm.signatures.enders=enders.slice(0,6);
  mm.signatures.taunts=byMove(mm.taunts,3);

  const pushRoute=(seq)=>{
    const clean=seq.filter(id=>id!==undefined&&id!==null&&mm.meta[id]?.usable);
    if(clean.length<1)return;
    const key=clean.join('>');
    if(!mm.routes.some(r=>r.join('>')===key))mm.routes.push(clean);
  };
  const st=mm.signatures.starters;
  const ln=linkers.slice(0,5).length?linkers.slice(0,5):mm.signatures.normals.slice(0,5);
  const sp=mm.signatures.specials;
  const hy=mm.signatures.hypers;
  const cr=mm.signatures.crouch;
  const heavy=byMove([...mm.atkStand,...mm.atkCrouch],8).filter(id=>(mm.meta[id]?.realDamage||0)>=35);

  for(const a of st.slice(0,3)) pushRoute([a]);
  for(const a of st.slice(0,3)) for(const b of ln.slice(0,3)) if(a!==b) pushRoute([a,b]);
  for(const a of st.slice(0,3)) for(const b of ln.slice(0,3)) for(const c of heavy.slice(0,3)) if(a!==b&&b!==c) pushRoute([a,b,c]);
  for(const a of st.slice(0,3)) for(const s of sp.slice(0,3)) pushRoute([a,s]);
  for(const a of st.slice(0,3)) for(const b of ln.slice(0,3)) for(const s of sp.slice(0,3)) if(a!==b) pushRoute([a,b,s]);
  for(const c of cr.slice(0,2)) for(const s of sp.slice(0,3)) pushRoute([c,s]);
  for(const a of st.slice(0,2)) for(const h of hy.slice(0,2)) pushRoute([a,h]);
  for(const a of st.slice(0,2)) for(const b of ln.slice(0,2)) for(const h of hy.slice(0,2)) if(a!==b) pushRoute([a,b,h]);
  for(const s of sp.slice(0,2)) for(const h of hy.slice(0,2)) if(s!==h) pushRoute([s,h]);
  const famEntries=[...mm.families.entries()].filter(([,ids])=>ids.length>=2);
  for(const [,ids] of famEntries.slice(0,5)){
    const seq=byMove(ids,4);
    if(seq.length>=2)pushRoute(seq.slice(0,2));
    if(seq.length>=3)pushRoute([seq[0],seq[1],seq[2]]);
  }

  if(!mm.routes.length){
    if(st[0])pushRoute([st[0]]);
    if(st[0]&&sp[0])pushRoute([st[0],sp[0]]);
    if(st[0]&&ln[0]&&sp[0])pushRoute([st[0],ln[0],sp[0]]);
    if(st[0]&&ln[0]&&hy[0])pushRoute([st[0],ln[0],hy[0]]);
  }

  return mm;
}

function rnd(arr,fallback){
  if(!arr||!arr.length)return fallback??0;
  return arr[Math.random()*arr.length|0];
}

// ═══════════════════════════════════════════════════════════════
//  CHARACTER PROFILER — extract true metrics from actual sprites
// ═══════════════════════════════════════════════════════════════
function profileCharacter(sprites,anims,moveMap){
  // Find the true character height using axis Y from stand sprites
  // axis Y = pixels from top of sprite canvas to the ground-level anchor
  // This IS the real character height in pixels, not the canvas height
  let axisY=120,charW=40,axisX=20;

  // Try stand anims in priority order
  const standCandidates=[...moveMap.stand];
  // Also try raw IDs 0-6 directly
  for(let i=0;i<=6;i++)if(!standCandidates.includes(i))standCandidates.unshift(i);

  outer:
  for(const standId of standCandidates){
    const frs=anims.get(standId);
    if(!frs?.length)continue;
    for(const fr of frs){
      const spr=sprites.get(`${fr.g},${fr.i}`);
      if(spr?.cvs&&spr.ay>20&&spr.ay<500){
        axisY=spr.ay+(fr.oy||0);
        axisX=spr.ax+(fr.ox||0);
        charW=spr.cvs.width;
        break outer;
      }
    }
  }

  // Fallback: scan all sprites for a reasonable axisY
  if(axisY===120){
    let best=0;
    for(const[,spr]of sprites){
      if(spr.ay>best&&spr.ay<400&&spr.cvs.height>40){
        best=spr.ay;axisY=spr.ay;axisX=spr.ax;charW=spr.cvs.width;
      }
    }
  }

  // Scale so character stands ~190px tall on canvas
  const TARGET_H=190;
  const scale=Math.max(0.75,Math.min(2.5,TARGET_H/Math.max(axisY,50)));

  // Body width and hit parameters derived from real character size
  const bodyW=Math.max(28,charW*0.42)*scale;
  const bodyH=axisY*scale;

  return{axisY,axisX,charW,scale,bodyW,bodyH};
}


function parseNumberList(v){
  return String(v||'').split(',').map(s=>parseFloat(s.trim())).filter(n=>!Number.isNaN(n));
}
function parseHitDefFiles(fileTexts){
  const byAnim=new Map(), byState=new Map(), stateAnim=new Map();
  const pushSpec=(anim,spec)=>{
    if(anim===undefined||anim===null||Number.isNaN(anim))return;
    if(!byAnim.has(anim))byAnim.set(anim,[]);
    byAnim.get(anim).push(spec);
    if(!byState.has(spec.stateNo))byState.set(spec.stateNo,[]);
    byState.get(spec.stateNo).push(spec);
  };
  for(const text of fileTexts){
    let curState=null, curAnim=null, sectionLines=[];
    const flushSection=()=>{
      if(curState===null||!sectionLines.length)return;
      const joined=sectionLines.join('\n');
      if(!/type\s*=\s*hitdef/i.test(joined))return;
      const anim=curAnim??stateAnim.get(curState);
      const dmgm=joined.match(/(^|\n)\s*damage\s*=\s*(-?\d+)(?:\s*,\s*(-?\d+))?/i);
      const guardm=joined.match(/(^|\n)\s*guardflag\s*=\s*([^\n\r]+)/i);
      const attrm=joined.match(/(^|\n)\s*attr\s*=\s*([^\n\r]+)/i);
      const ptm=joined.match(/(^|\n)\s*pausetime\s*=\s*([^\n\r]+)/i);
      const ghm=joined.match(/(^|\n)\s*ground\.hittime\s*=\s*(-?\d+)/i);
      const ahm=joined.match(/(^|\n)\s*air\.hittime\s*=\s*(-?\d+)/i);
      const gvm=joined.match(/(^|\n)\s*ground\.velocity\s*=\s*([^\n\r]+)/i);
      const avm=joined.match(/(^|\n)\s*air\.velocity\s*=\s*([^\n\r]+)/i);
      const ggvm=joined.match(/(^|\n)\s*guard\.velocity\s*=\s*([^\n\r]+)/i);
      const slidem=joined.match(/(^|\n)\s*ground\.slidetime\s*=\s*(-?\d+)/i);
      const spec={
        stateNo:curState,
        animId:parseInt(anim,10),
        damage:dmgm?Math.max(0,parseInt(dmgm[2],10)):0,
        guardDamage:dmgm&&dmgm[3]!==undefined?Math.max(0,parseInt(dmgm[3],10)):null,
        guardflag:(guardm?guardm[2]:'MA').trim().toUpperCase(),
        attr:(attrm?attrm[2]:'S,NA').trim().toUpperCase(),
        pausetime:parseNumberList(ptm?ptm[2]:'12,12'),
        groundHittime:ghm?Math.max(0,parseInt(ghm[2],10)):12,
        airHittime:ahm?Math.max(0,parseInt(ahm[2],10)):(ghm?Math.max(0,parseInt(ghm[2],10)):12),
        groundVelocity:parseNumberList(gvm?gvm[2]:'-2.4'),
        airVelocity:parseNumberList(avm?avm[2]:'-2,-4'),
        guardVelocity:parseNumberList(ggvm?ggvm[2]:'-1.2'),
        groundSlidetime:slidem?Math.max(0,parseInt(slidem[2],10)):8,
      };
      spec.isProjectile=/,\s*AP\b/.test(spec.attr)||/\bAP\b/.test(spec.attr);
      pushSpec(spec.animId,spec);
    };
    for(const raw of text.split(/\r?\n/)){
      const ci=raw.indexOf(';');
      const line=(ci>=0?raw.slice(0,ci):raw).trim();
      if(!line)continue;
      const sm=line.match(/^\[\s*statedef\s*(-?\d+)\s*\]/i);
      if(sm){ flushSection(); sectionLines=[]; curState=parseInt(sm[1],10); curAnim=null; continue; }
      const sec=line.match(/^\[(.+?)\]$/);
      if(sec){ flushSection(); sectionLines=[]; continue; }
      if(curState!==null){
        const am=line.match(/^anim\s*=\s*(-?\d+)/i);
        if(am){ curAnim=parseInt(am[1],10); stateAnim.set(curState,curAnim); }
      }
      sectionLines.push(line);
    }
    flushSection();
  }
  const byAnimBest=new Map();
  for(const [anim,list] of byAnim){
    const usable=list.filter(s=>s.damage>0||s.guardDamage!==null);
    if(!usable.length)continue;
    usable.sort((a,b)=>(b.damage-a.damage)||(b.groundHittime-a.groundHittime));
    const best=usable[0];
    best.multiCount=usable.length;
    byAnimBest.set(anim,best);
  }
  return {byAnim,byAnimBest,byState};
}

function parseCommandFiles(fileTexts){
  const specialStates=new Set(), hyperStates=new Set(), tauntStates=new Set(), commandByState=new Map(), commandDefs=new Map();
  const looksHyper=(name,cmd)=>{
    const s=`${name} ${cmd}`.toLowerCase();
    return /super|max|neo|desperation|sdm|\bdm\b|hcf,hcf|qcf,qcf|qcb,qcb|d,df,f,d,df,f|d,db,b,d,db,b/.test(s);
  };
  const looksSpecial=(name,cmd)=>{
    const s=`${name} ${cmd}`.toLowerCase();
    return /qcf|qcb|hcf|hcb|d,df,f|d,db,b|special|ex|projectile|fireball|rekka/.test(s);
  };
  for(const text of fileTexts){
    let section='';
    let cmdName='', cmdStr='';
    let ctrlType='', pendingName='';
    const flushCommand=()=>{
      if(cmdName)commandDefs.set(cmdName.toLowerCase(),{name:cmdName,cmd:cmdStr});
      cmdName='';cmdStr='';
    };
    const flushCtrl=(value)=>{
      if(!pendingName||value===undefined||value===null||Number.isNaN(value))return;
      const info=commandDefs.get(String(pendingName).toLowerCase())||{name:pendingName,cmd:''};
      commandByState.set(value,info);
      if(/taunt|provoc|beckon|intro|pose|come on|c'mon/i.test(`${info.name} ${info.cmd}`))tauntStates.add(value);
      else if(looksHyper(info.name,info.cmd))hyperStates.add(value);
      else if(looksSpecial(info.name,info.cmd))specialStates.add(value);
    };
    for(const raw of text.split(/\r?\n/)){
      const ci=raw.indexOf(';');
      const line=(ci>=0?raw.slice(0,ci):raw).trim();
      if(!line)continue;
      const sec=line.match(/^\[(.+?)\]$/);
      if(sec){
        if(section==='command')flushCommand();
        section=sec[1].trim().toLowerCase();
        ctrlType='';pendingName='';
        continue;
      }
      if(section==='command'){
        let m=line.match(/^name\s*=\s*"?([^"\r\n]+)"?/i);
        if(m){cmdName=m[1].trim();continue;}
        m=line.match(/^command\s*=\s*(.+)$/i);
        if(m){cmdStr=m[1].trim();continue;}
        continue;
      }
      const t=line.match(/^type\s*=\s*(changestate|selfstate|changeanim)/i);
      if(t){ctrlType=t[1].toLowerCase();pendingName='';continue;}
      const trig=line.match(/^trigger(?:all|\d+)\s*=\s*command\s*=\s*"?([^"\r\n]+)"?/i);
      if(trig){pendingName=trig[1].trim();continue;}
      const val=line.match(/^value\s*=\s*(-?\d+)/i);
      if(ctrlType&&pendingName&&val)flushCtrl(parseInt(val[1],10));
    }
    if(section==='command')flushCommand();
  }
  return {specialStates,hyperStates,tauntStates,commandByState};
}

function parseStateCatalog(fileTexts){
  const byState=new Map(), byAnim=new Map(), familyByAnim=new Map();
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const familyFrom=title=>{
    const src=norm(title);
    const m=src.match(/(power geyser|burn knuckle|crack shoot|rising tackle|buster wolf|heat drive|crow bite|minute spike|ein trigger|chain drive|ice breath|diamond breath|ray spin|lay spin|shiki|orochi nagi|reppuken|oniyaki|qcf qcf|qcb qcb|hcf hcb|hcb hcf|super|max2|max|neo|sdm|\bdm\b|hcf|hcb|qcf|qcb|rekka|projectile|fireball)/);
    return m?m[1].replace(/\s+/g,' ').trim():'';
  };
  for(const text of fileTexts){
    let curState=null, curType='';
    for(const raw of String(text||'').split(/\r?\n/)){
      const ci=raw.indexOf(';');
      const line=(ci>=0?raw.slice(0,ci):raw).trim();
      if(!line)continue;
      const sm=line.match(/^\[\s*statedef\s*(-?\d+)\s*\]/i);
      if(sm){curState=parseInt(sm[1],10);curType='';if(!byState.has(curState))byState.set(curState,{stateNo:curState,title:'',animId:null,type:'',changeStates:new Set(),hitdef:false,family:''});continue;}
      const sh=line.match(/^\[\s*state\s+(-?\d+)\s*,\s*([^\]]+)\]/i);
      if(sh){curState=parseInt(sh[1],10);const title=sh[2].trim();if(!byState.has(curState))byState.set(curState,{stateNo:curState,title,animId:null,type:'',changeStates:new Set(),hitdef:false,family:''});else if(title&&!byState.get(curState).title)byState.get(curState).title=title;continue;}
      if(curState===null)continue;
      let m=line.match(/^type\s*=\s*([a-z]+)/i);
      if(m){curType=m[1].toLowerCase();byState.get(curState).type=curType;if(curType==='hitdef')byState.get(curState).hitdef=true;continue;}
      m=line.match(/^anim\s*=\s*(-?\d+)/i);
      if(m){const aid=parseInt(m[1],10), st=byState.get(curState); if(st.animId===null)st.animId=aid; if(!byAnim.has(aid))byAnim.set(aid,[]); byAnim.get(aid).push(st); continue;}
      m=line.match(/^(?:value|stateno)\s*=\s*(-?\d+)/i);
      if(m&&/changestate|selfstate/i.test(curType||''))byState.get(curState).changeStates.add(parseInt(m[1],10));
    }
  }
  for(const st of byState.values()){
    st.family=familyFrom(st.title);
    if(st.animId!==null&&st.family&&!familyByAnim.has(st.animId))familyByAnim.set(st.animId,st.family);
  }
  return {byState,byAnim,familyByAnim};
}

// ═══════════════════════════════════════════════════════════════
//  CHARACTER LOADER
// ═══════════════════════════════════════════════════════════════
async function loadCharacter(zipBuf,prog){
  const zip=await JSZip.loadAsync(zipBuf);
  const byExt={};
  for(const[path,f]of Object.entries(zip.files)){
    if(f.dir)continue;
    const ext=path.split('.').pop().toLowerCase();
    (byExt[ext]=byExt[ext]||[]).push({path,f});
  }

  // ── Name from .def ──────────────────────────────────────────────
  prog(8,'Lendo .def...');
  let name='FIGHTER';
  if(byExt.def?.length){
    // Prefer the main def (not ending/neo variants)
    const defs=byExt.def.sort((a,b)=>{
      const na=a.path.toLowerCase(),nb=b.path.toLowerCase();
      const score=p=>p.includes('ending')||p.includes('neo')?1:0;
      return score(na)-score(nb);
    });
    for(const d of defs){
      try{
        const t=await d.f.async('text');
        const m=t.match(/^\s*name\s*=\s*"?([^"\n\r]+)/im);
        if(m){name=m[1].trim().replace(/"/g,'');break;}
      }catch(e){}
    }
  }

  // ── Palette .act ────────────────────────────────────────────────
  prog(18,'Lendo .act...');
  let actPal=null;
  if(byExt.act?.length){
    // Score: SFF-name match > pal1 / ends-in-1 > pal2 > largest
    const sffBase=(byExt.sff?.[0]?.path||'').split('/').pop().replace(/\.sff$/i,'').toLowerCase();
    const scored=byExt.act.map(e=>{
      const n=e.path.split('/').pop().toLowerCase().replace(/\.act$/,'');
      let score=0;
      if(n===sffBase||n===sffBase+'_01'||n===sffBase+'01')score=200;
      else if(/^pal[_-]?1(n)?$/.test(n)||/1$/.test(n))score=80;
      else if(/^pal[_-]?2(n)?$/.test(n)||/2$/.test(n))score=40;
      const sz=e.f._data?.uncompressedSize||e.f._data?.compressedSize||0;
      return{e,score,sz};
    });
    scored.sort((a,b)=>b.score-a.score||b.sz-a.sz);
    for(const{e}of scored){
      try{const ab=await e.f.async('arraybuffer');const d=new Uint8Array(ab);if(d.length>=768){actPal=d.slice(0,768);break;}}catch(e){}
    }
  }

  // ── Sprites from .sff ───────────────────────────────────────────
  prog(35,'Parseando .sff...');
  let sprites=new Map();
  if(byExt.sff?.length){
    // Pick largest SFF (most sprites) that is the character's main sprite sheet
    // Filter out ending SFFs by filename AND by being inside end/ending subdirs
    const mainSffs=byExt.sff.filter(e=>{
      const p=e.path.toLowerCase();
      return !p.includes('ending')&&!/[/\\]end[/\\]/.test(p);
    });
    const candidates=mainSffs.length?mainSffs:byExt.sff;
    const se=candidates.reduce((a,b)=>{
      const sa=b.f._data?.uncompressedSize||b.f._data?.compressedSize||0;
      const sb=a.f._data?.uncompressedSize||a.f._data?.compressedSize||0;
      return sa>sb?b:a;
    },candidates[0]);
    try{const sb=await se.f.async('arraybuffer');sprites=await parseSFF(sb,actPal);}
    catch(e){console.warn('SFF err:',e.message);}
  }

  // ── Fallback: loose images for non-MUGEN zips ───────────────────
  if(!sprites.size){
    prog(55,'Buscando imagens...');
    sprites=await loadLooseImages(byExt);
  }

  // ── Animations from .air ────────────────────────────────────────
  prog(72,'Parseando .air...');
  let anims=new Map();
  if(byExt.air?.length){
    // Prefer air matching char name or main def
    const mainAirs=byExt.air.filter(e=>!e.path.toLowerCase().includes('ending')&&!e.path.toLowerCase().startsWith('neo'));
    const airEntry=(mainAirs.length?mainAirs:byExt.air)[0];
    try{const at=await airEntry.f.async('text');anims=parseAIR(at);}catch(e){}
  }

  // ── Character state / HitDef info from .cns/.st ─────────────────
  prog(78,'Lendo estados...');
  let hitDefs={byAnim:new Map(),byAnimBest:new Map(),byState:new Map()};
  const stateTexts=[];
  for(const ext of ['cns','st']){
    for(const entry of(byExt[ext]||[])){
      try{stateTexts.push(await entry.f.async('text'));}catch(e){}
    }
  }
  if(stateTexts.length)try{hitDefs=parseHitDefFiles(stateTexts);}catch(e){console.warn('HitDef parse err:',e.message);}

  // ── Commands from .cmd ──────────────────────────────────────────
  prog(80,'Lendo comandos...');
  let commands={specialStates:new Set(),hyperStates:new Set(),tauntStates:new Set(),commandByState:new Map()};
  const cmdTexts=[];
  for(const entry of(byExt.cmd||[])){
    try{cmdTexts.push(await entry.f.async('text'));}catch(e){}
  }
  if(cmdTexts.length)try{commands=parseCommandFiles(cmdTexts);}catch(e){console.warn('CMD parse err:',e.message);}

  // ── Fallback: synthesize anims from sprites ─────────────────────
  if(!anims.size&&sprites.size){
    prog(82,'Sintetizando animações...');
    anims=synthesizeAnims(sprites);
  }

  prog(86,'Catalogando estados...');
  let stateCatalog={byState:new Map(),byAnim:new Map(),familyByAnim:new Map()};
  if(stateTexts.length)try{stateCatalog=parseStateCatalog(stateTexts);}catch(e){console.warn('State catalog parse err:',e.message);}
  prog(88,'Catalogando moveset...');
  const moveMap=buildMoveMap(anims,hitDefs.byAnimBest,commands,stateCatalog);
  const profile=profileCharacter(sprites,anims,moveMap);

  // ── Sounds from .snd ──────────────────────────────────────────────
  prog(93,'Carregando sons...');
  const snd=new SoundPlayer();
  if(byExt.snd?.length){
    // Pick main SND (not ending)
    const snds=byExt.snd.filter(e=>!e.path.toLowerCase().includes('ending'));
    const sndEntry=(snds.length?snds:byExt.snd)[0];
    try{
      const sb=await sndEntry.f.async('arraybuffer');
      const rawMap=await parseSND(sb);
      if(rawMap)await snd.load(rawMap);
    }catch(e){console.warn('SND load failed:',e.message);}
  }

  const poolSz=o=>o.length;
  console.log(`[${name}] scale=${profile.scale.toFixed(2)} axisY=${profile.axisY} stand:${poolSz(moveMap.stand)} atkSt:${poolSz(moveMap.atkStand)} sp:${poolSz(moveMap.specials)} hy:${poolSz(moveMap.hypers)} sprites:${sprites.size} sounds:${snd._bufs.size}grp`);
  prog(100,'OK!');
  return{name,sprites,anims,moveMap,profile,snd,hitDefs,commands,stateCatalog};
}

// ═══════════════════════════════════════════════════════════════
//  FIGHTER
// ═══════════════════════════════════════════════════════════════
