// game.js — partículas, HUD, Game loop, render, hits, rounds, UI, worker-clock
// ═══════════════════════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════════════════════
class Pt{
  constructor(x,y,big,type){
    // Clamp spawn to canvas so particles never originate off-screen
    this.x=Math.max(0,Math.min(CW,x));
    this.y=Math.max(0,Math.min(CH,y));
    this.big=big;
    this.type=type||'spark';
    const spd=big?8.5:3.8;
    this.vx=(Math.random()-.5)*spd*2.2;
    this.vy=(Math.random()-.5)*spd*1.8-2.4;
    this.life=big?38:22;this.max=this.life;
    this.r=big?(2.5+Math.random()*7):(1.0+Math.random()*3.5);
    const palBig=['#fff','#ffd700','#ff8800','#ff2020','#ffff00','#ff44aa'];
    const palSmall=['#fff','#00eaff','#ffd700','#aaffff'];
    const palStar=['#fff','#ffffaa','#ffdd55'];
    const pal=type==='star'?palStar:big?palBig:palSmall;
    this.col=pal[Math.random()*pal.length|0];
    this.rot=Math.random()*Math.PI*2;
    this.rotSpd=(Math.random()-.5)*0.35;
    this._additive=(big||type==='star'); // pre-decide blend mode
  }
  update(){
    this.vx*=0.82;this.vy=this.vy*0.82+0.28;
    this.x+=this.vx;this.y+=this.vy;
    this.rot+=this.rotSpd;
    this.life--;
    if(this.x<-60||this.x>CW+60||this.y>CH+60||this.y<-60)this.life=0;
  }
  draw(ctx){
    if(this.life<=0)return;
    const a=this.life/this.max;
    // Smoother fade: ease-out curve so particles don't pop in
    const alpha=Math.min(0.90,a*a*1.3);
    const r=this.r*Math.max(0.08,a);
    if(r<0.2||alpha<0.02)return;
    ctx.save();
    // Additive blending for big/special sparks — isolated in save/restore
    if(this._additive)ctx.globalCompositeOperation='lighter';
    ctx.globalAlpha=alpha;
    ctx.fillStyle=this.col;
    if(this.type==='star'&&r>1){
      ctx.translate(this.x,this.y);ctx.rotate(this.rot);
      ctx.beginPath();ctx.moveTo(0,-r*1.5);ctx.lineTo(r*0.45,0);ctx.lineTo(0,r*1.5);ctx.lineTo(-r*0.45,0);ctx.closePath();ctx.fill();
    }else{
      ctx.beginPath();ctx.arc(this.x,this.y,r,0,Math.PI*2);ctx.fill();
    }
    ctx.restore(); // always restore so compositeOp never leaks
  }
}

// ═══════════════════════════════════════════════════════════════
//  COMBO HUD
// ═══════════════════════════════════════════════════════════════
class ComboHUD{
  constructor(x,align){this.x=x;this.align=align;this.n=0;this.alpha=0;this.timer=0;this.scl=1;this.excl='';}
  hit(n){
    this.n=n;this.alpha=1;this.timer=105;this.scl=1.6;
    const ex=['CRUSHING!!','BRUTAL!!','ULTRA!!','GODLIKE!!','SAVAGE!!','MEGATON!!','PERFECT!!','UNSTOPPABLE!!','DIVINE!!'];
    this.excl=n>=5&&n%5===0?ex[Math.random()*ex.length|0]:'';
    this.hitCol=n>=15?'#ff2020':n>=8?'#ff8800':n>=4?'#ffd700':'#00ff88';
  }
  update(){
    if(this.timer>0)this.timer--;
    else this.alpha=Math.max(0,this.alpha-.024);
    this.scl=1+(this.scl-1)*.78;
  }
  draw(ctx){
    if(this.alpha<=0.02||this.n<2)return;
    const y=GROUND-200;
    const sz=Math.max(8,Math.min(58,Math.round(58*this.scl)));
    const col=this.hitCol||'#ffd700';
    ctx.save();
    ctx.globalAlpha=Math.min(1,this.alpha);
    ctx.textAlign=this.align;

    // Number
    ctx.font=`${sz}px 'Press Start 2P',monospace`;
    ctx.strokeStyle='#000';ctx.lineWidth=Math.max(3,7*(sz/58));
    ctx.strokeText(this.n,this.x,y);
    // Gradient only spans actual rendered size, not fixed 100px
    const hw=sz*0.65;
    const g=ctx.createLinearGradient(this.x-hw,y-sz,this.x+hw,y+10);
    g.addColorStop(0,'#ffffff');g.addColorStop(0.4,col);g.addColorStop(1,'#ff2020');
    ctx.fillStyle=g;ctx.fillText(this.n,this.x,y);

    // "HIT!!" label
    ctx.font=`12px 'Press Start 2P',monospace`;
    ctx.strokeStyle='#000';ctx.lineWidth=3;ctx.strokeText('HIT!!',this.x,y+20);
    ctx.fillStyle='#fff';ctx.fillText('HIT!!',this.x,y+20);

    // Exclamation label
    if(this.excl){
      ctx.font=`7px 'Press Start 2P',monospace`;
      ctx.strokeStyle='#000';ctx.lineWidth=2;ctx.strokeText(this.excl,this.x,y+36);
      ctx.fillStyle=col;ctx.fillText(this.excl,this.x,y+36);
    }
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════
//  GAME
// ═══════════════════════════════════════════════════════════════
class Game{
  constructor(canvas,c1,c2){
    this.cvs=canvas;this.ctx=canvas.getContext('2d');
    this.c1=c1;this.c2=c2;this.pts=[];
    this.annTxt='';this.annAlpha=0;this.annTick=0;this.annDur=0;
    this.shakeMag=0;this.shakeTimer=0;
    this.wins1=0;this.wins2=0;
    this.roundNo=1; // round counter displayed before each FIGHT!
    this.raf=null;
    // Slow motion
    this._slomoTicks=0;       // >0 = slomo active
    this._slomoKillCb=null;   // callback to run after slomo ends
    // Wall flash: {side:'left'|'right', alpha}
    this._wallFlash={alpha:0,side:'left'};
    // Hyper flash: full-screen white burst when hyper activates
    this._hyperFlash=0;
    this._hitOrderFlip=false;
    this._stepOrderFlip=false;
    this._spawnSwap=false; // round 1 sempre com P1 à esquerda; alterna a partir do round 2
    this._build();
    this._acc=0;this._lastTs=undefined;this._roundTicks=0;
    this._preRoundDelay=48; // show "ROUND 1" for ~0.8s before FIGHT!
    MatchLog.reset(); // v10: nova luta → novo log
    this._playIntros();  // v10: intros dos personagens como no jogo
    this._ann('ROUND 1',1,48);this.state='PRE_ROUND';
    _pushLog(`nextRound p1=${Math.round(this.f1.hp)} p2=${Math.round(this.f2.hp)}`);
  }
  _build(){
    const p1x=this._spawnSwap?750:210;
    const p2x=this._spawnSwap?210:750;
    const p1f=this._spawnSwap?-1:1;
    const p2f=this._spawnSwap?1:-1;
    this.f1=new Fighter(this.c1,p1x,p1f);
    this.f2=new Fighter(this.c2,p2x,p2f);
    // Pass win reference objects to AIs
    this.ai1=new AI(this.f1,this.f2,{get me(){return this._g?.wins1??0},get them(){return this._g?.wins2??0}});
    this.ai2=new AI(this.f2,this.f1,{get me(){return this._g?.wins2??0},get them(){return this._g?.wins1??0}});
    // Back-reference so winsRef getters resolve correctly
    this.ai1.winsRef._g=this;this.ai2.winsRef._g=this;
    this.hud1=new ComboHUD(110,'left');
    this.hud2=new ComboHUD(CW-110,'right');
    this._roundOver=false;this._roundDelay=0;this._roundTicks=0;this._pendingKO=null;
  }
  // v10: intros como no jogo — anim 190+ no round 1, prolonga o PRE_ROUND
  _playIntros(){
    if(_speedMult>1)return; // turbo pula intro
    let maxDur=0;
    for(const f of[this.f1,this.f2]){
      const intro=f.char.moveMap.intros?.[0];
      if(intro!=null&&f.playPose(intro,170))maxDur=Math.max(maxDur,f.tauntTimer);
    }
    if(maxDur>0)this._preRoundDelay=Math.max(this._preRoundDelay||48,maxDur+10);
  }
  _ann(txt,alpha,dur){this.annTxt=txt;this.annAlpha=alpha;this.annDur=dur;this.annTick=0;}
  // Called when a hyper (id>=3000) is activated — screen flash + brief slomo
  _hyperScene(fighter){
    this._hyperFlash=0.90;
    // Brief slomo only at normal speed and only if no slomo already running
    if(_speedMult<=1&&this._slomoTicks<=0){
      this._slomoTicks=20;
      // No kill callback — slomo just fades out naturally
    }
    this.shakeMag=Math.max(this.shakeMag,5);this.shakeTimer=Math.max(this.shakeTimer,8);
    // Big burst of star particles at fighter position
    if(_speedMult<=1){
      const px=fighter.x, py=fighter.y-fighter._prof.bodyH*0.5;
      for(let i=0;i<22;i++)this.pts.push(new Pt(px+(Math.random()-.5)*60,py+(Math.random()-.5)*50,true,'star'));
    }
  }

  _bootstrapEngagement(){
    if(this._roundOver||this.state!=='FIGHT')return;
    this._roundTicks=(this._roundTicks||0)+1;
    if(this._roundTicks>150)return;
    const dist=Math.abs(this.f1.x-this.f2.x);
    const passive=f=>(!f.inAir && !f.isAtk && (f.state==='STAND'||f.state==='WALK_F'||f.state==='WALK_B'||f.state==='RUN_F'||f.state==='RUN_B'||f.state==='CROUCH'));
    this.f1.facing=this.f1.x<this.f2.x?1:-1;
    this.f2.facing=this.f2.x<this.f1.x?1:-1;
    const engageR=Math.max(this.ai1?this.ai1._hitRv:120,this.ai2?this.ai2._hitRv:120);
    const forceOne=(fighter,other,ai)=>{
      if(!passive(fighter)||fighter.inAir||fighter.state==='GUARD'||fighter.state==='ATTACK')return false;
      fighter.facing=fighter.x<other.x?1:-1;
      if(dist>engageR*0.95){
        const runSpd=dist>260?6.0:4.3;
        if(dist>engageR*1.45){fighter.setState('RUN_F',{dur:12});fighter._walkTarget=runSpd;fighter._moveSpeed=runSpd;}
        else{fighter.setState('WALK_F');fighter._walkTarget=4.0;fighter._moveSpeed=4.0;}
        return true;
      }
      const seq=ai?ai._pickAtk(dist):null;
      if(seq&&seq.length){ ai.queue=[]; ai._seq(seq); return true; }
      const bm=ai?.bestNormal||null;
      if(bm){ ai?ai._doAtk(bm):fighter.doAtk(bm); return true; }
      fighter.setState('STAND',{stopNow:true});
      return false;
    };
    const a1=forceOne(this.f1,this.f2,this.ai1);
    const a2=forceOne(this.f2,this.f1,this.ai2);
    if((this._roundTicks||0)%20===1)_pushLog(`bootstrap dist=${dist.toFixed(1)} a1=${a1?1:0} a2=${a2?1:0}`);
  }

  _checkHits(){
    MatchLog.simTick++; // v10: relógio de simulação p/ planilha
    const hitPairs=this._hitOrderFlip?
      [[this.f2,this.f1,this.ai2,this.ai1],[this.f1,this.f2,this.ai1,this.ai2]]:
      [[this.f1,this.f2,this.ai1,this.ai2],[this.f2,this.f1,this.ai2,this.ai1]];
    this._hitOrderFlip=!this._hitOrderFlip;
    for(const[atk,def,atkAI,defAI]of hitPairs){
      if(!atk.isAtk||def.state==='KO')continue;
      if(def.invFrames>0)continue;
      if(atk.hasHit){
        const isMultiHit=atk.actId>=1000;
        if(!isMultiHit)continue;
        if(atk._lastHitFi===atk.fi)continue;
        if((atk.stTick-(atk._lastHitTick||-999))<Math.max(4,(atk._hitSpec?.multiCount||1)>1?5:7))continue;
        atk.hasHit=false;
      }
      const ab=atk.getAtk();if(!ab)continue;
      const hb=def.getHurt();
      const hitSpec=ab.spec||atk._hitSpec||atk._hitSpecFor?.(atk.actId)||null;
      if(ab.x<hb.x+hb.w&&ab.x+ab.w>hb.x&&ab.y<hb.y+hb.h&&ab.y+ab.h>hb.y){
        atk.hasHit=true;
        atk._lastHitFi=atk.fi;
        atk._lastHitTick=atk.stTick;
        const big=atk.atkDmg>72||((hitSpec?.damage||0)>72);
        atk.snd.resume();
        if(atk.snd._bufs.has(2))atk.snd.playPunch(big?0.9:0.7);
        else playSynthHit(big);
        // hit() now returns whether hit landed (false if blocked)
        const landed=def.hit(atk.atkDmg,atk.facing,hitSpec,atk.state);
        if(!landed){MatchLog.hit(this,atk,def,true,0,0);atk._gainMeter(12);continue;} // blocked — no combo, no effects
        { // v12: dano alimenta o modelo de confronto dos dois lados
          const aAI=atk===this.f1?this.ai1:this.ai2, dAI=atk===this.f1?this.ai2:this.ai1;
          aAI?.matchup?.noteDamage(atk.atkDmg,0);
          dAI?.matchup?.noteDamage(0,atk.atkDmg);
        }

        defAI.notifyHit();
        defAI.notifyHitReceived(def.x);
        atkAI.notifyAtkHit(atk.actId,def.x);
        atk._gainMeter(Math.min(52,14+atk.atkDmg*0.14)+(atk.actId>=1000?8:0));
        // Track combo route damage for empirical route learning
        if(atkAI._currentRouteSeq?.length){
          atkAI._currentRouteDmg=(atkAI._currentRouteDmg||0)+atk.atkDmg;
          if(!atkAI.queue?.length){
            atkAI.notifyComboRoute(atkAI._currentRouteSeq,atkAI._currentRouteDmg);
            atkAI._currentRouteSeq=null;atkAI._currentRouteDmg=0;
          }
        }
        atk.comboCount++;atk.comboTimer=80; // KOF2002: tight combo window ~1.3s
        MatchLog.hit(this,atk,def,false,atk.atkDmg,atk.comboCount); // v10
        (atk===this.f1?this.hud1:this.hud2).hit(atk.comboCount);

        if(big){this.shakeMag=7;this.shakeTimer=10;}
        else if(atk.atkDmg>58){this.shakeMag=3;this.shakeTimer=5;}

        // Wall flash if defender near edge
        if(def.x<130){this._wallFlash={alpha:0.6,side:'left'};}
        else if(def.x>CW-130){this._wallFlash={alpha:0.6,side:'right'};}

        const px=def.x+(atk.facing*(def._prof.charW*0.27*def.scale));
        const py=def.y-def._prof.bodyH*0.55;
        if(_speedMult<=1){
          const isSpecial=atk.actId>=1000;
          const isHyper=atk.actId>=3000;
          // KOF-style: star sparks for specials/hypers, circle sparks for normals
          const cnt=isHyper?30:isSpecial?18:big?14:7;
          const type=isSpecial?'star':'spark';
          for(let i=0;i<cnt;i++){
            const ox=(Math.random()-.5)*40,oy=(Math.random()-.5)*35;
            this.pts.push(new Pt(px+ox,py+oy,big||isSpecial,type));
          }
          // Flash ring on hypers
          if(isHyper){
            for(let i=0;i<8;i++)this.pts.push(new Pt(px+(Math.random()-.5)*20,py+(Math.random()-.5)*20,true,'star'));
          }
        }

        if(def.hp<=0&&!this._roundOver){
          // Collect pending KOs — check for simultaneous after full pair loop
          if(!this._pendingKO) this._pendingKO=[];
          this._pendingKO.push({atk,def,atkAI,defAI});
        }
      }
    }
    // Resolve pending KOs — detect simultaneous (DRAW) vs single winner
    if(this._pendingKO?.length){
      const kos=this._pendingKO;this._pendingKO=null;
      this._roundOver=true;
      if(kos.length>=2){
        // Simultaneous KO — DRAW: both lose, neither gains HP advantage
        if(_speedMult<=1){
          this._slomoTicks=38;
          this._slomoKillCb=()=>this._finishDraw();
        }else this._finishDraw();
      }else{
        const{atk,def,atkAI,defAI}=kos[0];
        if(_speedMult<=1){
          this._slomoTicks=38;
          this._slomoKillCb=()=>this._finishRound(atk,def,atkAI,defAI);
        }else this._finishRound(atk,def,atkAI,defAI);
      }
    }
    // Push fighters apart — but allow real side swaps during jump-over / knockback situations.
    const baseWidth=Math.max(this.f1._prof.charW*this.f1.scale,this.f2._prof.charW*this.f2.scale);
    const minDist=Math.max(55,baseWidth*0.78);
    const crossDist=Math.max(28,baseWidth*0.34);
    const ddx=this.f2.x-this.f1.x,absDdx=Math.abs(ddx);
    if(absDdx<minDist&&absDdx>0){
      const overlap=minDist-absDdx;
      const dir=ddx>=0?1:-1;
      const f1Atk=this.f1.state==='ATTACK',f2Atk=this.f2.state==='ATTACK';
      const airborneSwap=this.f1.inAir||this.f2.inAir||this.f1.state==='HIT_AIR'||this.f2.state==='HIT_AIR';
      const knockSwap=this.f1.state==='KO'||this.f2.state==='KO';
      const wantsCross=absDdx<crossDist&&(airborneSwap||knockSwap);
      if(wantsCross){
        const mid=(this.f1.x+this.f2.x)*0.5;
        const gap=Math.max(20,minDist*0.30);
        if(dir>0){
          this.f1.x=mid+gap;
          this.f2.x=mid-gap;
        }else{
          this.f1.x=mid-gap;
          this.f2.x=mid+gap;
        }
        const f1vx=this.f1.vx,f2vx=this.f2.vx;
        this.f1.vx=Math.sign(f1vx||dir)*Math.max(Math.abs(f1vx),1.25);
        this.f2.vx=Math.sign(f2vx||-dir)*Math.max(Math.abs(f2vx),1.25);
      }else if(f1Atk&&!f2Atk&&this.f2.state!=='KO'){
        // Attacking fighter stays put, defender gets pushed.
        this.f2.x+=overlap*dir*0.85;
      }else if(f2Atk&&!f1Atk&&this.f1.state!=='KO'){
        this.f1.x-=overlap*dir*0.85;
      }else{
        // Both or neither attacking: split evenly, with a tiny extra nudge to prevent sticky overlap.
        const half=Math.max(1.2,overlap*0.52);
        if(this.f1.state!=='KO')this.f1.x-=half*dir;
        if(this.f2.state!=='KO')this.f2.x+=half*dir;
      }
      this.f1.x=Math.max(65,Math.min(CW-65,this.f1.x));
      this.f2.x=Math.max(65,Math.min(CW-65,this.f2.x));
    }
    // Wall flash: also trigger passively when fighter is cornered
    for(const f of[this.f1,this.f2]){
      if(f.x<=68&&(f.state==='HIT'||f.state==='KO'))this._wallFlash={alpha:Math.min(0.5,this._wallFlash.alpha+0.08),side:'left'};
      if(f.x>=CW-68&&(f.state==='HIT'||f.state==='KO'))this._wallFlash={alpha:Math.min(0.5,this._wallFlash.alpha+0.08),side:'right'};
    }
  }
  _finishRound(atk,def,atkAI,defAI){
    const winner=atk===this.f1?1:2;
    // Winner keeps remaining life and recovers only a small portion for the next round.
    const RECOVER_WINNER=0.22;
    if(winner===1){
      this._carryHp1=Math.min(this.f1.maxHp,Math.max(1,this.f1.hp)+Math.round(this.f1.maxHp*RECOVER_WINNER));
      this._carryHp2=this.f2.maxHp;
      // FIX: equilibrar meter carry — era 180 vs 120, agora 160 vs 140
      this._carryMeter1=Math.min(this.f1.maxMeter,this.f1.meter+300);
      this._carryMeter2=Math.max(600,Math.min(this.f2.maxMeter,this.f2.meter+250));
      this.wins1++;this.ai1.notifyRoundEnd(true);this.ai2.notifyRoundEnd(false);
    }
    else{
      this._carryHp2=Math.min(this.f2.maxHp,Math.max(1,this.f2.hp)+Math.round(this.f2.maxHp*RECOVER_WINNER));
      this._carryHp1=this.f1.maxHp;
      // FIX: equilibrar meter carry — era 180 vs 120, agora 160 vs 140
      this._carryMeter2=Math.max(160,Math.min(this.f2.maxMeter,this.f2.meter+120));
      this._carryMeter1=Math.max(140,Math.min(this.f1.maxMeter,this.f1.meter+100));
      this.wins2++;this.ai2.notifyRoundEnd(true);this.ai1.notifyRoundEnd(false);
    }
    // v10: registra KO + resumo do round e pose de vitória do vencedor
    MatchLog.evt(this,'KO',atk.char?.name,def.char?.name);
    MatchLog.round(this,winner,(winner===1?this.c1:this.c2).name);
    {const wf=winner===1?this.f1:this.f2;
     const wp=(wf.char.moveMap.winPoses?.[0])??(wf.char.moveMap.intros?.[0])??(wf.char.moveMap.taunts?.[0]);
     if(wp!=null&&wf.state!=='KO')wf.playPose(wp,150);}
    if(this.wins1%WIN_LIMIT===0||this.wins2%WIN_LIMIT===0){
      const wname=(this.wins1%WIN_LIMIT===0?this.c1:this.c2).name.slice(0,10);
      this._ann(wname+' LEADS!',1,100);
    }else{
      this._ann('K.O.!',1,90);
    }
    // Delay via ticks de simulação (não setTimeout) — funciona em qualquer velocidade
    // Normal: ~150 ticks (~2.5s), Turbo: ~30 ticks
    this._roundDelay=_speedMult>1?30:150;
  }
  _finishDraw(){
    // Simultaneous KO — both lose the round, HP resets to full for both
    this._carryHp1=this.f1.maxHp;
    this._carryHp2=this.f2.maxHp;
    this._carryMeter1=Math.max(140,Math.min(this.f1.maxMeter,this.f1.meter+110));
    this._carryMeter2=Math.max(140,Math.min(this.f2.maxMeter,this.f2.meter+110));
    this.ai1.notifyRoundEnd(false);this.ai2.notifyRoundEnd(false);
    MatchLog.evt(this,'KO','EMPATE','duplo nocaute');
    MatchLog.round(this,0,'EMPATE'); // v10
    this._ann('DRAW!',1,95);
    this._roundDelay=_speedMult>1?30:150;
    _pushLog('DRAW - simultaneous KO');
  }
  _nextRound(){
    this.roundNo=(this.roundNo||1)+1;
    this._spawnSwap=false; // P1 sempre à esquerda, P2 sempre à direita
    const mem1=this.ai1?this.ai1._extractMemory():null;
    const mem2=this.ai2?this.ai2._extractMemory():null;
    this.f1=new Fighter(this.c1,210,1);
    this.f2=new Fighter(this.c2,750,-1);
    this.f1.hp=Math.max(1,Math.min(this.f1.maxHp,this._carryHp1||this.f1.maxHp));
    this.f2.hp=Math.max(1,Math.min(this.f2.maxHp,this._carryHp2||this.f2.maxHp));
    this.f1.meter=Math.max(120,Math.min(this.f1.maxMeter,this._carryMeter1??320));
    this.f2.meter=Math.max(120,Math.min(this.f2.maxMeter,this._carryMeter2??320));
    this.f1.facing=1;this.f2.facing=-1;
    this.f1._walkTarget=Math.max(3.4,this.f1.char.profile.bodyW*0.028);this.f1._moveSpeed=this.f1._walkTarget;
    this.f2._walkTarget=Math.max(3.4,this.f2.char.profile.bodyW*0.028);this.f2._moveSpeed=this.f2._walkTarget;
    this.f1.setState('STAND',{stopNow:true});this.f2.setState('STAND',{stopNow:true});
    this.f1._resetVisualCache();this.f2._resetVisualCache();
    this.ai1=new AI(this.f1,this.f2,{get me(){return this._g?.wins1??0},get them(){return this._g?.wins2??0}});
    this.ai2=new AI(this.f2,this.f1,{get me(){return this._g?.wins2??0},get them(){return this._g?.wins1??0}});
    this.ai1.winsRef._g=this;this.ai2.winsRef._g=this;
    if(mem1)this.ai1._injectMemory(mem1);
    if(mem2)this.ai2._injectMemory(mem2);
    this.ai1.resetForNewRound();this.ai2.resetForNewRound();
    this.ai1._forceEngageTicks=90;this.ai2._forceEngageTicks=90;
    this.ai1.roundStartRushTicks=90;this.ai2.roundStartRushTicks=90;
    this._roundTicks=0;
    this.hud1=new ComboHUD(110,'left');
    this.hud2=new ComboHUD(CW-110,'right');
    this.pts=[];
    this._hitOrderFlip=false;
    this._stepOrderFlip=false;
    this._pendingKO=null;
    this._roundOver=false;
    this._roundDelay=0;
    this._slomoTicks=0;
    this._slomoKillCb=null;
    this.shakeMag=0;this.shakeTimer=0;
    this._hyperFlash=0;
    this._wallFlash={alpha:0,side:'left'};
    this._acc=0;this._lastTs=undefined;
    Stage.next(); // v10: cicla cenários a cada round
    const roundLabel='ROUND '+this.roundNo;
    this._preRoundDelay=_speedMult>1?12:48;
    this._ann(roundLabel,1,this._preRoundDelay);this.state='PRE_ROUND';
    _pushLog(`_nextRound #${this.roundNo} p1hp=${Math.round(this.f1.hp)} p2hp=${Math.round(this.f2.hp)} p1mp=${Math.round(this.f1.meter)} p2mp=${Math.round(this.f2.meter)}`);
  }
  loop(){
    this._hidden=false;
    this.raf=requestAnimationFrame(ts=>this._frame(ts));
  }
  _frame(ts){
    this.raf=requestAnimationFrame(ts=>this._frame(ts));
    if(document.hidden){this._lastTs=undefined;return;}
    if(this._lastTs===undefined)this._lastTs=ts;
    let elapsed=ts-this._lastTs;this._lastTs=ts;

    const spd=_speedMult;
    let effectiveSpd=spd;
    if(this._slomoTicks>0&&spd<=1){
      effectiveSpd=0.25; // visually slow but still runs ~1 step every 4 frames
      // Decrement slomo by RAF frames — NOT sim steps — so it's always ~0.6s real time
      this._slomoTicks--;
      if(this._slomoTicks<=0&&this._slomoKillCb){
        const cb=this._slomoKillCb;this._slomoKillCb=null;cb();
      }
    }
    if(elapsed>SIM_STEP*4)elapsed=SIM_STEP*4;
    this._acc=(this._acc||0)+elapsed*effectiveSpd;

    const maxSteps=spd<=1?2:Math.min(spd*4,500)|0;
    let steps=0;
    while(this._acc>=SIM_STEP&&steps<maxSteps){
      this._acc-=SIM_STEP;steps++;
      if(this.state==='PRE_ROUND'){
        // Fighters animate their idle while waiting for FIGHT! — prevents frozen-then-dragging visual
        this.f1.update();this.f2.update();
        if(!this._preRoundDelay||--this._preRoundDelay<=0){
          this._preRoundDelay=0;
          this._ann('FIGHT!',1,55);this.state='FIGHT';
        }
      }else if(this.state==='FIGHT'&&!this._roundOver){
        this._bootstrapEngagement();
        if(this._stepOrderFlip){this.ai2.update();this.ai1.update();this.f2.update();this.f1.update();}
        else{this.ai1.update();this.ai2.update();this.f1.update();this.f2.update();}
        this._stepOrderFlip=!this._stepOrderFlip;
        this._checkHits();
      }else if(this._roundOver){
        this.f1.update();this.f2.update();
        // BUG FIX: só avança o delay/nextRound depois que _finishRound foi chamado
        // (i.e. _slomoKillCb===null). Sem isso, se o KO ocorre no step 1 de um frame
        // com 2 steps acumulados, o step 2 vê _roundDelay=0 e dispara _nextRound()
        // ANTES do slow-motion terminar e _finishRound contabilizar a vitória.
        if(this._slomoKillCb===null){
          if(this._roundDelay>0){
            this._roundDelay--;
            if(this._roundDelay<=0)this._nextRound();
          }
        }
      }
      _advanceSharedFx(this,spd);
    }
    if(_logEnabled&&this.state==='FIGHT'&&!this._roundOver&&this.f1&&this.f2&&this.ai1&&this.ai2){
      if((this._logTick=(this._logTick||0)+1)%20===1){
        const bothPassive=((this.f1.state==='STAND'||this.f1.state==='CROUCH')&&!this.f1.isAtk&&!this.f1.inAir)&&((this.f2.state==='STAND'||this.f2.state==='CROUCH')&&!this.f2.isAtk&&!this.f2.inAir);
        if(bothPassive)_pushLog(`passive dist=${Math.abs(this.f1.x-this.f2.x).toFixed(1)} q1=${this.ai1.queue.length} q2=${this.ai2.queue.length} rush1=${this.ai1.roundStartRushTicks} rush2=${this.ai2.roundStartRushTicks}`);
      }
    }
    this.render();
  }
  _drawStage(ctx){ // v10: fundo "cover" + vinheta de legibilidade
    if(!Stage.draw(ctx)){
      // sem cenário: mantém preto puro (comportamento original)
    }
  }
  render(){
    const ctx=this.ctx;

    // ── PRE-CLEAR: always covers full canvas before any transform ────
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,CW,CH);
    ctx.fillStyle='#000';ctx.fillRect(0,0,CW,CH);
    this._drawStage(ctx);ctx.restore();

    // ── SHAKE context: only fighters + ground + particles ────────────
    ctx.save();
    if(this.shakeMag>0){
      const sx=(Math.random()-.5)*this.shakeMag*2;
      const sy=(Math.random()-.5)*this.shakeMag;
      ctx.translate(sx,sy);
      // Extra clear inside shake to cover bleed at edges
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,CW,CH);
      ctx.fillStyle='#000';ctx.fillRect(0,0,CW,CH);
      this._drawStage(ctx);ctx.restore();
    }

    // Ground line
    ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,GROUND);ctx.lineTo(CW,GROUND);ctx.stroke();

    // Fighters — invincibility blink
    if(this.f1.invFrames<=0||Math.floor(this.f1.invFrames/4)%2===0)this.f1.draw(ctx);
    if(this.f2.invFrames<=0||Math.floor(this.f2.invFrames/4)%2===0)this.f2.draw(ctx);

    ctx.restore(); // ← end shake — everything below is stable ────────

    // ── WALL FLASH (outside shake so it doesn't jitter) ──────────────
    if(this._wallFlash.alpha>0.01){
      const wfa=this._wallFlash.alpha;
      const gw=ctx.createLinearGradient(
        this._wallFlash.side==='left'?0:CW,0,
        this._wallFlash.side==='left'?180:CW-180,0
      );
      gw.addColorStop(0,`rgba(255,80,0,${Math.min(0.7,wfa).toFixed(2)})`);
      gw.addColorStop(1,'rgba(255,80,0,0)');
      ctx.fillStyle=gw;ctx.fillRect(0,0,CW,CH);
    }

    // ── HYPER FLASH (full-screen white burst) ────────────────────────
    if(this._hyperFlash>0.01){
      ctx.save();ctx.globalAlpha=this._hyperFlash*0.60;
      ctx.fillStyle='#ffffff';ctx.fillRect(0,0,CW,CH);
      ctx.restore();
    }

    // ── PUNISH WINDOW INDICATORS ──────────────────────────────────────
    for(const[ai,f]of[[this.ai1,this.f1],[this.ai2,this.f2]]){
      if(ai.punishVisTimer>0){
        const a=Math.min(1,ai.punishVisTimer/24);
        ctx.save();ctx.globalAlpha=a;
        const px=f.x,py=f.y-f._prof.bodyH-22;
        ctx.font='bold 8px "Press Start 2P",monospace';
        ctx.textAlign='center';
        ctx.strokeStyle='#000';ctx.lineWidth=3;ctx.strokeText('PUNISH!',px,py);
        ctx.fillStyle='#ffcc00';ctx.fillText('PUNISH!',px,py);
        ctx.strokeStyle=`rgba(255,200,0,${(a*0.6).toFixed(2)})`;
        ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(px,py+4,18*(1.1-a*0.1),0,Math.PI*2);ctx.stroke();
        ctx.restore();
      }
    }

    // ── SLOW MOTION VIGNETTE ─────────────────────────────────────────
    if(this._slomoTicks>0&&_speedMult<=1){
      const sv=Math.min(0.55,this._slomoTicks/38*0.55);
      const gv=ctx.createRadialGradient(CW/2,CH/2,CH*0.25,CW/2,CH/2,CH*0.85);
      gv.addColorStop(0,'rgba(0,0,0,0)');
      gv.addColorStop(1,`rgba(0,0,0,${sv.toFixed(2)})`);
      ctx.fillStyle=gv;ctx.fillRect(0,0,CW,CH);
      ctx.fillStyle=`rgba(255,255,255,${(sv*0.10).toFixed(2)})`;ctx.fillRect(0,0,CW,CH);
      ctx.save();ctx.globalAlpha=Math.min(1,sv*1.8);
      ctx.font='7px "Press Start 2P",monospace';ctx.fillStyle='#fff';
      ctx.textAlign='right';ctx.fillText('SLOW MO',CW-8,CH-20);
      ctx.restore();
    }

    // ── PARTICLES (stable coords, no shake) ─────────────────────────
    this.pts.forEach(p=>p.draw(ctx));

    // ── COMBO HUDs ───────────────────────────────────────────────────
    this.hud1.draw(ctx);this.hud2.draw(ctx);

    // ── HUD: HP BARS (KOF2002 style) ─────────────────────────────────
    {
      const BAR_Y=36, BAR_H=14, BAR_W=380;
      const BAR_X1=20, BAR_X2=CW-20-BAR_W; // P1 left-aligned, P2 right-aligned
      const hpColor=(pct)=>pct>0.50?'#20e050':pct>0.25?'#e0c020':'#e02020';
      const drawBar=(x,w,pct,flipped)=>{
        const filled=Math.max(0,Math.min(1,pct))*w;
        // Background
        ctx.save();
        ctx.fillStyle='#111';ctx.fillRect(x,BAR_Y,w,BAR_H);
        // HP fill (P1 fills left→right, P2 fills right→left)
        const fillX=flipped?x+w-filled:x;
        // Danger pulse when HP < 25%
        const pulse=pct<0.25&&Math.floor(Date.now()/150)%2===0;
        ctx.fillStyle=pulse?'#ff4444':hpColor(pct);
        ctx.fillRect(fillX,BAR_Y,filled,BAR_H);
        // Highlight strip
        ctx.globalAlpha=0.30;ctx.fillStyle='#fff';
        ctx.fillRect(flipped?x+w-filled:x,BAR_Y,filled,BAR_H*0.35);
        ctx.globalAlpha=1;
        // Border
        ctx.strokeStyle='rgba(255,255,255,0.18)';ctx.lineWidth=1;
        ctx.strokeRect(x,BAR_Y,w,BAR_H);
        ctx.restore();
      };
      // P1 bar
      drawBar(BAR_X1,BAR_W,this.f1.hp/this.f1.maxHp,false);
      // P2 bar (fills right-to-left)
      drawBar(BAR_X2,BAR_W,this.f2.hp/this.f2.maxHp,true);
      // HP numbers
      ctx.save();
      ctx.font='8px "Press Start 2P",monospace';
      ctx.fillStyle='rgba(255,255,255,0.55)';
      ctx.textAlign='left'; ctx.fillText(Math.max(0,Math.ceil(this.f1.hp)),BAR_X1+4,BAR_Y+BAR_H-2);
      ctx.textAlign='right';ctx.fillText(Math.max(0,Math.ceil(this.f2.hp)),BAR_X2+BAR_W-4,BAR_Y+BAR_H-2);
      ctx.restore();
    }
    {
      const MY=56,MH=8,MW=300,MX1=20,MX2=CW-20-MW;
      const drawM=(x,w,pct,flip)=>{
        const filled=Math.max(0,Math.min(1,pct))*w;
        ctx.save();
        ctx.fillStyle='#081018';ctx.fillRect(x,MY,w,MH);
        const fx=flip?x+w-filled:x;
        const g=ctx.createLinearGradient(x,0,x+w,0);
        g.addColorStop(0,'#13a8ff');g.addColorStop(1,'#7cf5ff');
        ctx.fillStyle=g;ctx.fillRect(fx,MY,filled,MH);
        ctx.strokeStyle='rgba(255,255,255,0.16)';ctx.strokeRect(x,MY,w,MH);
        ctx.restore();
      };
      drawM(MX1,MW,this.f1.meter/this.f1.maxMeter,false);
      drawM(MX2,MW,this.f2.meter/this.f2.maxMeter,true);
      ctx.save();ctx.font='6px "Press Start 2P",monospace';ctx.fillStyle='rgba(180,235,255,0.8)';
      ctx.textAlign='left';ctx.fillText('POW '+Math.round(this.f1.meter),MX1+2,MY+7);
      ctx.textAlign='right';ctx.fillText('POW '+Math.round(this.f2.meter),MX2+MW-2,MY+7);
      ctx.restore();
    }
    const CX=CW/2;
    const lead1=this.wins1>this.wins2,lead2=this.wins2>this.wins1;
    ctx.save();ctx.textAlign='right';ctx.font='7px "Press Start 2P",monospace';
    ctx.fillStyle=lead1?'rgba(255,215,0,0.7)':'rgba(255,255,255,0.35)';
    ctx.fillText(this.c1.name.slice(0,10),CX-46,21);ctx.restore();

    ctx.save();ctx.textAlign='right';
    ctx.font=`bold ${lead1?20:16}px "Press Start 2P",monospace`;
    ctx.fillStyle=lead1?'#ffd700':'#aaa';
    ctx.fillText(this.wins1,CX-14,23);ctx.restore();

    ctx.save();ctx.textAlign='center';
    ctx.font='7px "Press Start 2P",monospace';ctx.fillStyle='#ff2020';
    ctx.fillText('VS',CX,16);
    ctx.font='5px "Press Start 2P",monospace';ctx.fillStyle='rgba(255,255,255,0.25)';
    ctx.fillText('FT'+WIN_LIMIT,CX,26);ctx.restore();

    ctx.save();ctx.textAlign='left';
    ctx.font=`bold ${lead2?20:16}px "Press Start 2P",monospace`;
    ctx.fillStyle=lead2?'#ffd700':'#aaa';
    ctx.fillText(this.wins2,CX+14,23);ctx.restore();

    ctx.save();ctx.textAlign='left';ctx.font='7px "Press Start 2P",monospace';
    ctx.fillStyle=lead2?'rgba(255,215,0,0.7)':'rgba(255,255,255,0.35)';
    ctx.fillText(this.c2.name.slice(0,10),CX+46,21);ctx.restore();

    // Speed badge — always visible, position top-right to avoid overlap with credit at bottom
    {
      const spLabel=_speedMult===1?'1X':_speedMult+'X';
      const bc=_speedMult>=100?'#ff00ff':_speedMult>=50?'#ff2020':_speedMult>=20?'#ff8800':_speedMult>1?'#ffd700':'#555';
      ctx.save();
      ctx.font=`bold ${_speedMult>1?11:9}px "Press Start 2P",monospace`;
      ctx.textAlign='right';
      // Stroke for legibility over any background
      ctx.strokeStyle='#000';ctx.lineWidth=3;ctx.strokeText(spLabel,CW-6,14);
      ctx.fillStyle=bc;ctx.fillText(spLabel,CW-6,14);
      ctx.restore();
    }

    // ── DEBUG hitboxes ────────────────────────────────────────────────
    if(this._dbg){
      ctx.save();ctx.globalAlpha=.55;
      for(const[f,col]of[[this.f1,'#00ff44'],[this.f2,'#ff4444']]){
        const hb=f.getHurt();
        ctx.strokeStyle=col;ctx.lineWidth=1;ctx.strokeRect(hb.x,hb.y,hb.w,hb.h);
        const ab=f.getAtk();
        if(ab){ctx.strokeStyle='#ffe000';ctx.lineWidth=2;ctx.strokeRect(ab.x,ab.y,ab.w,ab.h);}
        const plan=f===this.f1?this.ai1.plan:this.ai2.plan;
        ctx.fillStyle=col;ctx.font='6px monospace';ctx.textAlign='center';
        ctx.fillText(`${f.state}|${plan}|z:${f===this.f1?this.ai1._zone(Math.abs(this.f1.x-this.f2.x)):this.ai2._zone(Math.abs(this.f1.x-this.f2.x))}|d=${Math.abs(this.f1.x-this.f2.x)|0}`,f.x,f.y-f._prof.bodyH-10);
      }
      ctx.restore();
    }

    // Credit
    ctx.save();ctx.globalAlpha=.13;ctx.font='6px "Press Start 2P",monospace';ctx.fillStyle='#aaa';
    ctx.textAlign='center';ctx.fillText('created by @wanqerson',CW/2,CH-4);ctx.restore();

    // Live log sync — only when panel is open, every 20 frames
    if(_logEnabled){
      if((this._logSyncTick=(this._logSyncTick||0)+1)%20===0)this._syncLogPanel();
    }

    // ── CENTER ANNOUNCEMENT ───────────────────────────────────────────
    if(this.annAlpha>0){
      ctx.save();ctx.globalAlpha=this.annAlpha;ctx.textAlign='center';
      const annSz=Math.min(50,CW/16|0);
      ctx.font=`${annSz}px 'Press Start 2P',monospace`;
      ctx.strokeStyle='#000';ctx.lineWidth=9;ctx.strokeText(this.annTxt,CW/2,CH/2+18);
      const g=ctx.createLinearGradient(CW/2-130,CH/2-40,CW/2+130,CH/2+20);
      g.addColorStop(0,'#fff');g.addColorStop(.45,'#ffd700');g.addColorStop(1,'#ff2020');
      ctx.fillStyle=g;ctx.fillText(this.annTxt,CW/2,CH/2+18);
      ctx.restore();
    }
  }
  stop(){
    cancelAnimationFrame(this.raf);
    this.raf=null;
    this._lastTs=undefined;this._acc=0;
  }
  _captureStatusLine(label,f,ai){
    if(!f||!ai)return `${label}: -`;
    const dist=Math.abs((this.f1?.x||0)-(this.f2?.x||0)).toFixed(1);
    return `${label} st=${_uiLine(f.state)} atk=${f.isAtk?1:0} air=${f.inAir?1:0} x=${f.x.toFixed(1)} vx=${f.vx.toFixed(2)} hp=${Math.round(f.hp)} mp=${Math.round(f.meter||0)} fi=${f.fi||0} plan=${_uiLine(ai.plan)} q=${ai.queue?ai.queue.length:0} tick=${_uiLine(ai.tick)}/${_uiLine(ai.interval)} stun=${_uiLine(ai.stunCooldown)} rush=${_uiLine(ai.roundStartRushTicks)} dist=${dist}`;
  }
  _syncLogPanel(){
    const body=document.getElementById('log-body');
    if(!body)return;
    if(!_logEnabled){_logPanel(false);return;}
    _logPanel(true);
    const lines=[];
    lines.push(`game state=${_uiLine(this.state)} roundOver=${this._roundOver?1:0} delay=${this._roundDelay||0} ticks=${this._roundTicks||0} speed=${_speedMult} hidden=${document.hidden?1:0}`);
    lines.push(this._captureStatusLine('P1',this.f1,this.ai1));
    lines.push(this._captureStatusLine('P2',this.f2,this.ai2));
    lines.push('');
    lines.push('EVENTOS:');
    lines.push(..._logLines.slice(-18));
    body.textContent=lines.join('\n');
  }
  toggleLog(){_logEnabled=!_logEnabled;_pushLog(`log ${_logEnabled?'ON':'OFF'}`);this._syncLogPanel();}
  toggleDbg(){this._dbg=!this._dbg;}
}

// ── Simulation background loop ───────────────────────────────────────────────
// RAF freezes on hidden tabs/windows. We use a dual-loop:
// · RAF for rendering (only when tab visible)
// · setInterval (always running) drives simulation at full _speedMult speed
let _simInterval=null,_simWorker=null,_bgLastTs=0,_bgFrac=0;
const SIM_HZ=1000/60; // ~16.67ms base tick

function _advanceSharedFx(g,spd){
  if(g.shakeTimer>0){g.shakeTimer--;if(g.shakeTimer<=0)g.shakeMag=0;}
  if(g._wallFlash.alpha>0)g._wallFlash.alpha=Math.max(0,g._wallFlash.alpha-0.035);
  if(g._hyperFlash>0)g._hyperFlash=Math.max(0,g._hyperFlash-0.055);
  if(spd<=1){
    let pi=0;
    for(let pj=0;pj<g.pts.length;pj++){
      g.pts[pj].update();
      if(g.pts[pj].life>0)g.pts[pi++]=g.pts[pj];
    }
    g.pts.length=pi;
  }else g.pts.length=0;
  g.hud1.update();g.hud2.update();
  if(g.annDur>0&&++g.annTick>=g.annDur){g.annAlpha=Math.max(0,g.annAlpha-.04);if(g.annAlpha<=0)g.annDur=0;}
}

const _bgActive=()=>document.hidden||!document.hasFocus();

function _runSimSteps(n){
  if(!game)return;
  const spd=Math.max(1,_speedMult);
  for(let i=0;i<n;i++){
    if(game._slomoTicks>0&&_speedMult<=1){
      // BUG FIX: slomo no background sim só roda se _bgActive() para não conflitar com _frame
      if(_bgActive()){
        game._slomoTicks--;
        if(game._slomoTicks<=0&&game._slomoKillCb){const cb=game._slomoKillCb;game._slomoKillCb=null;cb();}
      }
    }
    if(game.state==='PRE_ROUND'){
      game.f1.update();game.f2.update();
      if(!game._preRoundDelay||--game._preRoundDelay<=0){
        game._preRoundDelay=0;
        game._ann('FIGHT!',1,55);game.state='FIGHT';
      }
    }else if(game.state==='FIGHT'&&!game._roundOver){
      game._bootstrapEngagement();
      if(game._stepOrderFlip){game.ai2.update();game.ai1.update();game.f2.update();game.f1.update();}
      else{game.ai1.update();game.ai2.update();game.f1.update();game.f2.update();}
      game._stepOrderFlip=!game._stepOrderFlip;
      game._checkHits();
    }else if(game._roundOver){
      game.f1.update();game.f2.update();
      // BUG FIX: mesmo guarda do _frame — não avançar enquanto _slomoKillCb pendente
      if(game._slomoKillCb===null){
        if(game._roundDelay>0){
          game._roundDelay--;
          if(game._roundDelay<=0)game._nextRound();
        }
      }
    }
    _advanceSharedFx(game,spd);
  }
}

function _startBackgroundSim(){
  if(_simInterval)return;
  _bgLastTs=performance.now();_bgFrac=0;
  // v10: relógio em Web Worker — browsers limitam setInterval da página a
  // 1 tick/s (e até 1/min) em abas ocultas; timers de Worker NÃO sofrem
  // esse throttling, então a luta continua em velocidade real fora da aba.
  const _bgTick=()=>{
    if(!game)return;
    const now=performance.now();
    let elapsed=Math.max(0,now-(_bgLastTs||now));
    _bgLastTs=now;
    if(!_bgActive())return;
    // Hidden/background tabs can throttle timers heavily; catch up by wall-clock time.
    let rawSteps=(elapsed/SIM_STEP)*Math.max(1,_speedMult)+_bgFrac;
    let steps=Math.floor(rawSteps);
    _bgFrac=rawSteps-steps;
    steps=Math.max(1,Math.min(steps,900));
    _runSimSteps(steps);
    // Clear particles (no rendering anyway)
    game.pts.length=0;
  };
  try{
    const blob=new Blob(['setInterval(()=>postMessage(0),50);'],{type:'text/javascript'});
    _simWorker=new Worker(URL.createObjectURL(blob));
    _simWorker.onmessage=_bgTick;
    _simInterval=true; // marca como ativo
  }catch(e){
    _simInterval=setInterval(_bgTick,SIM_HZ); // fallback
  }
}

function _pauseRAFForBackground(){
  if(!game)return;
  if(game.raf){cancelAnimationFrame(game.raf);game.raf=null;}
  game._lastTs=undefined;game._acc=0;
  _bgLastTs=performance.now();
}
function _resumeRAFFromBackground(){
  if(!game||game.raf)return;
  _bgLastTs=performance.now();
  game._lastTs=undefined;game._acc=0;
  game.raf=requestAnimationFrame(ts=>game._frame(ts));
}
document.addEventListener('visibilitychange',()=>{if(_bgActive())_pauseRAFForBackground();else _resumeRAFFromBackground();});
window.addEventListener('blur',()=>{if(_bgActive())_pauseRAFForBackground();});
window.addEventListener('focus',()=>{if(!_bgActive())_resumeRAFFromBackground();});

// ═══════════════════════════════════════════════════════════════
//  UI
// ═══════════════════════════════════════════════════════════════
let chars=[null,null],game=null;
function toggleMute(){
  _manualMuted=!_manualMuted;
  _globalMuted=_manualMuted;
  const ico=document.getElementById('mute-ico');
  if(ico)ico.textContent=_globalMuted?'🔇':'🔊';
}
document.addEventListener('keydown',e=>{
  if(e.key==='d'||e.key==='D'){if(game)game.toggleDbg();}
  if(e.key==='g'||e.key==='G'){if(game)game.toggleLog();}
  if(e.key==='r'||e.key==='R'){if(game){
    game.stop();
    game._build();
    game.wins1=0;game.wins2=0;game.roundNo=1;
    game._preRoundDelay=48;
    MatchLog.reset();game._playIntros(); // v10
    game._ann('ROUND 1',1,48);game.state='PRE_ROUND';
    game.loop();
  }}
  if(e.key==='l'||e.key==='L'){toggleMute();}
  if(e.key==='x'||e.key==='X'){exportMatchSheet();} // v10
  if(e.key==='t'||e.key==='T'){
    // T toggles between 1x and last used turbo speed (default 10x)
    if(_speedMult===1){_speedMult=_lastTurboSpeed;}
    else{_lastTurboSpeed=_speedMult;_speedMult=1;}
    // CRITICAL: reset accumulator on speed change — prevents residual acceleration
    if(game){game._acc=0;game._lastTs=undefined;}
    _applySpeedAudio();
  }
  if(e.key==='+'||e.key==='='||e.key==='NumpadAdd'){
    if(_speedMult<10)       _speedMult=_speedMult+1;
    else if(_speedMult<100) _speedMult=Math.min(100,_speedMult+5);
    else                    _speedMult=_speedMult+25;
    if(_speedMult>1)_lastTurboSpeed=_speedMult;
    if(game){game._acc=0;game._lastTs=undefined;} // reset acc on every speed change
    _applySpeedAudio();
  }
  if(e.key==='-'||e.key==='NumpadSubtract'){
    if(_speedMult>100)      _speedMult=Math.max(100,_speedMult-25);
    else if(_speedMult>10)  _speedMult=Math.max(10,_speedMult-5);
    else                    _speedMult=Math.max(1,_speedMult-1);
    if(_speedMult>1)_lastTurboSpeed=_speedMult;
    if(game){game._acc=0;game._lastTs=undefined;} // reset acc on every speed change
    _applySpeedAudio();
  }
});
function dg(e,s){e.preventDefault();document.getElementById('dz'+s).classList.add('drag-over');}
function dl(e,s){e.preventDefault();document.getElementById('dz'+s).classList.remove('drag-over');}
function dp(e,s){e.preventDefault();document.getElementById('dz'+s).classList.remove('drag-over');if(e.dataTransfer.files[0])loadZip(s,e.dataTransfer.files[0]);}
async function loadZip(slot,file){
  if(!file)return;
  const ds=document.getElementById('ds'+slot),dz=document.getElementById('dz'+slot);
  ds.textContent='Processando...';ds.className='dz-status';
  try{
    const ab=await file.arrayBuffer();
    const char=await loadCharacter(ab,(pct,msg)=>{ds.textContent=pct+'% '+msg;});
    chars[slot-1]=char;
    ds.textContent='✔ '+char.name+` (${char.sprites.size} sprites, scl ${char.profile.scale.toFixed(2)})`;
    ds.className='dz-status ok';dz.classList.add('loaded');
    document.getElementById('fight-btn').classList.add('show');
  }catch(e){ds.textContent='❌ '+e.message;console.error(e);}
}
function setLoad(p,m){document.getElementById('load-bar').style.width=p+'%';document.getElementById('load-status').textContent=m;}
async function startFight(){
  if(!chars[0])return;
  document.getElementById('upload-screen').style.display='none';
  document.getElementById('loading').classList.add('show');
  try{
    if(!chars[1]){
      // Deep-clone: share sprites/anims/moveMap/profile but give a FRESH SoundPlayer
      // so debounce maps and AudioContext are independent between the two fighters
      const snd2=new SoundPlayer();
      snd2._bufs=chars[0].snd._bufs; // share decoded AudioBuffers (read-only, safe)
      snd2._ctx =chars[0].snd._ctx;  // share AudioContext (one per page is fine)
      chars[1]={...chars[0],name:chars[0].name+' II',snd:snd2};
    }
    setLoad(100,'Iniciando...');await new Promise(r=>setTimeout(r,300));
    document.getElementById('loading').classList.remove('show');
    document.getElementById('fight-screen').classList.add('show');
    Stage.applyDom(); // v11: fundo cobre a tela inteira
    if(game)game.stop();
    game=new Game(document.getElementById('game-canvas'),chars[0],chars[1]);
    _pushLog('game created');
    game.loop();
    _startBackgroundSim(); // keep sim alive on hidden tabs
    // Resume AudioContext on first click (browser autoplay policy)
    document.getElementById('game-canvas').addEventListener('click',()=>{
      chars[0]?.snd?.resume();chars[1]?.snd?.resume();
    },{once:true});
  }catch(e){document.getElementById('load-status').textContent='Erro: '+e.message;console.error(e);}
}
